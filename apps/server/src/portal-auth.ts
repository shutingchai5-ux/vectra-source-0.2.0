import { randomBytes, createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { error, type DeploymentConfig } from "@vectra/shared";
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
export class PortalAuth {
  readonly cookieName:string;
  private attempts=new Map<string,{at:number;count:number}>();
  constructor(private db:Database,private deployment:Pick<DeploymentConfig,"publicUrl"|"username"|"passwordHash">&{identity:string},accounts:ReadonlyArray<{username:string;passwordHash:string}>=[]){
    this.cookieName="vectra_"+deployment.identity.replace(/-/g,"_")+"_login";
    db.exec("CREATE TABLE IF NOT EXISTS portal_accounts(username TEXT PRIMARY KEY,password_hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS portal_sessions(token_hash TEXT PRIMARY KEY,username TEXT NOT NULL,expires_at INTEGER NOT NULL)");
    for(const account of [deployment,...accounts])db.query("INSERT OR IGNORE INTO portal_accounts VALUES(?,?)").run(account.username,account.passwordHash);
  }
  allowedOrigin(request:Request){
    const origin=request.headers.get("origin"),site=request.headers.get("sec-fetch-site"),url=new URL(request.url);
    if(origin&&origin!==this.deployment.publicUrl.replace(/\/$/,"")&&origin!==url.origin||site&&site!=="same-origin"&&site!=="none")throw error("origin_forbidden","请从本端的同源页面操作。",403);
  }
  username(request:Request):string|undefined{
    const token=request.headers.get("cookie")?.split(";").map(value=>value.trim()).find(value=>value.startsWith(this.cookieName+"="))?.slice(this.cookieName.length+1);
    if(!token||token.length>200)return;
    const row=this.db.query<{expires_at:number;username:string},[string]>("SELECT expires_at,username FROM portal_sessions WHERE token_hash=?").get(digest(token));
    return row&&row.expires_at>Date.now()?row.username:undefined;
  }
  authenticated(request:Request):boolean{return !!this.username(request);}
  require(request:Request){
    const username=this.username(request);if(!username)throw error("portal_login_required","请先登录本端账号。",401);
    this.allowedOrigin(request);
    return username;
  }
  async login(request:Request,input:unknown,address="local"){
    this.allowedOrigin(request);
    const value=input as Record<string,unknown>;
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["username","password"].includes(key))||typeof value.username!=="string"||typeof value.password!=="string"||value.password.length>256)throw error("login_failed","账号或密码无效。",401);
    const attemptKey=address+":"+digest(value.username),now=Date.now(),attempt=this.attempts.get(attemptKey);
    if(attempt&&now-attempt.at<60000&&attempt.count>=8)throw error("login_limited","尝试次数较多，请一分钟后再登录。",429);
    if(this.attempts.size>1000)this.attempts.clear();
    const count=attempt&&now-attempt.at<60000?attempt.count+1:1;this.attempts.set(attemptKey,{at:now,count});
    const account=this.db.query<{password_hash:string},[string]>("SELECT password_hash FROM portal_accounts WHERE username=?").get(value.username);
    const valid=await Bun.password.verify(value.password,account?.password_hash??this.deployment.passwordHash);
    if(!account||!valid)throw error("login_failed","账号或密码无效。",401);
    this.attempts.delete(attemptKey);
    const token=randomBytes(32).toString("base64url");
    this.db.query("DELETE FROM portal_sessions WHERE expires_at<=?").run(now);
    this.db.query("INSERT INTO portal_sessions VALUES(?,?,?)").run(digest(token),value.username,now+12*3600000);
    return this.cookie(token,request);
  }
  logout(request:Request){
    this.allowedOrigin(request);
    const token=request.headers.get("cookie")?.split(";").map(value=>value.trim()).find(value=>value.startsWith(this.cookieName+"="))?.slice(this.cookieName.length+1);
    if(token)this.db.query("DELETE FROM portal_sessions WHERE token_hash=?").run(digest(token));
    return this.cookie("",request,true);
  }
  private cookie(value:string,request:Request,remove=false){
    return this.cookieName+"="+value+"; Path=/; HttpOnly; SameSite=Strict; Max-Age="+(remove?0:43200)+(new URL(request.url).protocol==="https:"||new URL(this.deployment.publicUrl).protocol==="https:"?"; Secure":"");
  }
}

