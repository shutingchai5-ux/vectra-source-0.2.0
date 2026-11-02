import { randomUUID,constants } from "node:crypto";
import { error,asError,type DeploymentConfig,type JsonObject } from "@vectra/shared";
import { canonical,hash,type Security } from "./security";
export type FederationHandler=(peer:string,kind:string,data:JsonObject)=>Promise<unknown>|unknown;
interface Connection{chunks:Buffer[];length:number;done:boolean;closed:boolean;peer?:string;pending?:{bytes:Buffer;offset:number;end:boolean};message?:(value:unknown)=>void;fail?:(cause:unknown)=>void;}
type Socket=Bun.Socket<Connection>;
const blockedVersions=constants.SSL_OP_NO_TLSv1|constants.SSL_OP_NO_TLSv1_1|constants.SSL_OP_NO_TLSv1_2|constants.SSL_OP_NO_SSLv3;
const state=():Connection=>({chunks:[],length:0,done:false,closed:false});
function flush(socket:Socket){const data=socket.data,pending=data.pending;if(!pending||data.closed)return;const count=socket.write(pending.bytes,pending.offset,pending.bytes.length-pending.offset);if(count<0){data.fail?.(error("federation_unavailable","协作连接已关闭。",503));return;}pending.offset+=count;if(pending.offset===pending.bytes.length){data.pending=undefined;if(pending.end)socket.end();}}
function send(socket:Socket,value:unknown,end:boolean){if(socket.data.closed)return;socket.data.pending={bytes:Buffer.from(canonical(value)+"\n"),offset:0,end};flush(socket);}
function receive(socket:Socket,chunk:Buffer,maximum:number){const data=socket.data;if(data.done||data.closed)return;const newline=chunk.indexOf(10),part=newline>=0?chunk.subarray(0,newline):chunk;data.length+=part.length;
  if(data.length>maximum){data.fail?.(error("federation_size","协作消息过大。",413));socket.terminate();return;}data.chunks.push(Buffer.from(part));
  if(newline>=0){data.done=true;try{const value=JSON.parse(Buffer.concat(data.chunks).toString("utf8"));data.chunks=[];data.message?.(value);}catch{data.fail?.(error("invalid_json","协作消息格式无效。",422));socket.terminate();}}
}
export class FederationTransport{
  private listener?:Bun.TCPSocketListener<Connection>;
  private seen=new Map<string,number>();
  private sockets=new Set<Socket>();
  constructor(readonly security:Security,readonly deployment:DeploymentConfig,private handler:FederationHandler,private diagnostic?:(cause:unknown)=>void){}
  private tls(){return {...this.security.tls(this.deployment.identity),requestCert:true,rejectUnauthorized:true,secureOptions:blockedVersions};}
  private peer(socket:Socket,expected?:string){const cert=socket.getPeerCertificate(),peer=cert&&this.security.nodes().find(node=>node.fingerprint===cert.fingerprint256)?.id;
    if(!socket.authorized||socket.getTLSVersion()!=="TLSv1.3"||!peer||peer===this.deployment.identity||!Object.hasOwn(this.deployment.federation.peers,peer)||expected&&peer!==expected)throw error("federation_identity","TLS 1.3证书与登记协作身份不符。",403);return peer;
  }
  private async dispatch(peer:string,envelope:unknown){const message=this.security.verify(envelope,peer),now=Date.now();
    if(message.recipient!==this.deployment.identity||typeof message.kind!=="string"||typeof message.nonce!=="string"||!/^[a-f0-9-]{36}$/.test(message.nonce)||typeof message.createdAt!=="number"||message.createdAt>now+5000||typeof message.expiresAt!=="number"||message.expiresAt<now||message.expiresAt-message.createdAt>120000||!message.data||typeof message.data!=="object"||Array.isArray(message.data))throw error("federation_binding","协作消息范围、有效期或接收方无效。",403);
    for(const[key,expiry]of this.seen)if(expiry<now)this.seen.delete(key);
    const replayKey=peer+":"+message.nonce;if(this.seen.has(replayKey)||this.seen.size>=10000)throw error("replay","重复或过量的协作消息。",409);this.seen.set(replayKey,message.expiresAt);
    return await this.handler(peer,message.kind,message.data as JsonObject);
  }
  async start(){
    this.listener=Bun.listen<Connection>({hostname:this.deployment.federation.host,port:this.deployment.federation.port,tls:this.tls(),socket:{
      open:socket=>{socket.data=state();this.sockets.add(socket);socket.timeout(15);try{socket.data.peer=this.peer(socket);}catch(cause){this.diagnostic?.(cause);socket.terminate();return;}
        socket.data.fail=cause=>this.diagnostic?.(cause);
        socket.data.message=envelope=>{void this.dispatch(socket.data.peer!,envelope).then(result=>send(socket,this.security.sign(this.deployment.identity,{kind:"reply",requestDigest:hash(envelope),createdAt:Date.now(),data:result??null}),true)).catch(cause=>{this.diagnostic?.(cause);const value=asError(cause);send(socket,this.security.sign(this.deployment.identity,{kind:"reply",requestDigest:hash(envelope),createdAt:Date.now(),error:{code:value.code,message:value.message,status:value.status}}),true);});};
      },
      data:(socket,chunk)=>receive(socket,chunk,524288),drain:flush,
      close:socket=>{if(socket.data)socket.data.closed=true;this.sockets.delete(socket);},
      error:(socket,cause)=>{socket.data?.fail?.(cause);},timeout:socket=>{socket.data?.fail?.(error("federation_timeout","协作连接超时。",504));socket.terminate();},
    }});
  }
  call(peer:string,kind:string,data:JsonObject={},signal?:AbortSignal):Promise<unknown>{
    if(!Object.hasOwn(this.deployment.federation.peers,peer)||peer===this.deployment.identity)return Promise.reject(error("federation_identity","目标协作身份无效。",403));
    if(signal?.aborted)return Promise.reject(error("cancelled","协作请求已取消。",409));
    const url=new URL(this.deployment.federation.peers[peer]),now=Date.now(),envelope=this.security.sign(this.deployment.identity,{recipient:peer,kind,data,nonce:randomUUID(),createdAt:now,expiresAt:now+60000});
    if(Buffer.byteLength(canonical(envelope))>524287)return Promise.reject(error("federation_size","协作请求过大，请减少分组或范围。",413));
    return new Promise((resolve,reject)=>{let settled=false,connection:Socket|undefined;const data=state();
      const abort=()=>{fail(error("cancelled","协作请求已取消。",409));connection?.terminate();};
      const fail=(cause:unknown)=>{if(settled)return;settled=true;signal?.removeEventListener("abort",abort);reject(cause);};
      data.fail=fail;data.message=value=>{try{const result=this.security.verify(value,peer);if(result.kind!=="reply"||result.requestDigest!==hash(envelope)||typeof result.createdAt!=="number"||Math.abs(Date.now()-result.createdAt)>120000)throw error("federation_binding","协作响应不属于本次请求。",403);
        if(result.error){const failure=result.error as JsonObject;throw error(String(failure.code),String(failure.message).slice(0,500),Number(failure.status)||503);}
        if(!settled){settled=true;signal?.removeEventListener("abort",abort);resolve(result.data);}connection?.end();
      }catch(cause){fail(cause);connection?.end();}};
      signal?.addEventListener("abort",abort,{once:true});
      void Bun.connect<Connection>({hostname:url.hostname.replace(/^\[|\]$/g,""),port:Number(url.port),tls:{...this.tls(),serverName:peer},data,socket:{
        open:socket=>{connection=socket;this.sockets.add(socket);socket.timeout(15);try{this.peer(socket,peer);if(signal?.aborted){abort();return;}send(socket,envelope,false);}catch(cause){fail(cause);socket.terminate();}},
        data:(socket,chunk)=>receive(socket,chunk,2097152),drain:flush,
        close:socket=>{socket.data.closed=true;this.sockets.delete(socket);fail(error("federation_unavailable","协作连接未完整返回。",503));},
        error:(socket,_cause)=>{fail(error("federation_unavailable","协作连接中断，请检查地址、证书和在线状态。",503));socket.terminate();},
        connectError:()=>fail(error("federation_unavailable","无法连接企业协作服务，请检查地址、证书和在线状态。",503)),
        timeout:socket=>{fail(error("federation_timeout","协作响应超时。",504));socket.terminate();},
      }}).catch(()=>fail(error("federation_unavailable","无法连接企业协作服务，请检查地址、证书和在线状态。",503)));
    });
  }
  async close(){this.listener?.stop(true);this.listener=undefined;for(const socket of this.sockets)if(!socket.data.closed)socket.terminate();this.sockets.clear();}
}
