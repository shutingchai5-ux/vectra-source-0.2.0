import "reflect-metadata";
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";
import canonicalize from "canonicalize";
import { validateQuery } from "./statistics";
import { error, PARTICIPANTS, REGISTERED_IDENTITIES, identityProfile, type ParkSettings, type JsonObject, type PublicNode, type SignedEnvelope } from "@vectra/shared";

export const IDENTITIES = REGISTERED_IDENTITIES;
export type Identity = typeof IDENTITIES[number];
export function canonical(value: unknown): string {
  const inspect = (entry: unknown, depth = 0): void => {
    if (depth > 40) throw error("invalid_json", "数据嵌套层数过多。", 422);
    if (typeof entry === "number" && (!Number.isFinite(entry) || Number.isInteger(entry) && !Number.isSafeInteger(entry))) throw error("invalid_number", "数值不能无损表示。", 422);
    if (entry === null || ["string", "boolean", "number"].includes(typeof entry)) return;
    if (Array.isArray(entry)) { for (const child of entry) inspect(child, depth + 1); return; }
    if (typeof entry !== "object" || !entry || Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) throw error("invalid_json", "只允许 JSON 数据。", 422);
    for (const child of Object.values(entry)) inspect(child, depth + 1);
  };
  inspect(value);
  const result = canonicalize(value);
  if (typeof result !== "string") throw error("invalid_json", "数据无法规范化。", 422);
  return result;
}
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function atomicWrite(path: string, value: string | Buffer) {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
export function seal(value: unknown, key: Buffer, context: string): JsonObject {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(canonical(value)), cipher.final()]);
  return { version: 1, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}
export function unseal(envelope: unknown, key: Buffer, context: string): unknown {
  try {
    const data = envelope as Record<string, string>;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(data.nonce, "base64url"));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(data.tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
  } catch { throw error("ciphertext_invalid", "AES-GCM 认证解密失败。", 403); }
}
interface Registry { caFingerprint: string; nodes: Record<string, PublicNode> }
export class Security {
  private constructor(readonly root: string, readonly registry: Registry) {}
  static async open(root: string): Promise<Security> {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const registryPath = join(root, "registry.json");
    if (!existsSync(registryPath)) {
      // A partial initialization is evidence to inspect; never silently replace existing keys.
      if (existsSync(join(root, "ca.crt"))) throw error("pki_incomplete", "身份初始化不完整，请检查新数据目录。", 500);
      const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
      const caKeys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
      const dates = { notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 365 * 86400_000), signingAlgorithm: alg };
      const ca = await x509.X509CertificateGenerator.createSelfSigned({ ...dates, name: "CN=VECTRA Local CA", keys: caKeys, extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
      ] });
      atomicWrite(join(root, "ca.crt"), ca.toString("pem"));
      atomicWrite(join(root, "ca.key"), pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", caKeys.privateKey)));
      const nodes: Registry["nodes"] = {};
      for (const id of IDENTITIES) {
        const folder = join(root, id); mkdirSync(folder, { mode: 0o700 });
        const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
        const cert = await x509.X509CertificateGenerator.create({ ...dates, subject: `CN=${id}`, issuer: ca.subject,
          publicKey: keys.publicKey, signingKey: caKeys.privateKey, extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]),
            new x509.SubjectAlternativeNameExtension([{ type: "dns", value: id }, { type: "url", value: `urn:vectra:${id}` }]),
            await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
          ] });
        const signing = generateKeyPairSync("ed25519");
        atomicWrite(join(folder, "tls.crt"), cert.toString("pem"));
        atomicWrite(join(folder, "tls.key"), pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)));
        atomicWrite(join(folder, "signing.key"), signing.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
        atomicWrite(join(folder, "input.key"), randomBytes(32));
        nodes[id] = { id, ...identityProfile(id)!, fingerprint: new X509Certificate(cert.toString("pem")).fingerprint256,
          signingPublicKey: signing.publicKey.export({ format: "pem", type: "spki" }).toString(), certificateExpires: dates.notAfter.toISOString() };
      }
      atomicWrite(registryPath, canonical({ caFingerprint: new X509Certificate(ca.toString("pem")).fingerprint256, nodes }));
      atomicWrite(join(root, "storage.key"), randomBytes(32));
    }
    const instance = new Security(root, JSON.parse(readFileSync(registryPath, "utf8")));
    instance.validate(true);
    await instance.addAgentIdentities();
    instance.validate(); return instance;
  }
  /** Offline provisioning only: rotate enterprise identities before exporting independent deployments. */
  async reissueParticipants() {
    const ca=new X509Certificate(this.ca()),alg={name:"ECDSA",namedCurve:"P-256",hash:"SHA-256"};
    const caKey=await crypto.subtle.importKey("pkcs8",new Uint8Array(createPrivateKey(readFileSync(join(this.root,"ca.key"))).export({format:"der",type:"pkcs8"})),alg,true,["sign"]);
    const nodes={...this.registry.nodes};
    for(const id of PARTICIPANTS){
      const keys=await crypto.subtle.generateKey(alg,true,["sign","verify"]),folder=join(this.root,id);mkdirSync(folder,{recursive:true});
      const cert=await x509.X509CertificateGenerator.create({subject:"CN="+id,issuer:ca.subject,publicKey:keys.publicKey,signingKey:caKey,signingAlgorithm:alg,
        notBefore:new Date(Date.now()-60000),notAfter:new Date(Math.min(Date.now()+365*86400000,Date.parse(ca.validTo))),extensions:[
          new x509.BasicConstraintsExtension(false,undefined,true),new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature,true),
          new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1","1.3.6.1.5.5.7.3.2"]),
          new x509.SubjectAlternativeNameExtension([{type:"dns",value:id},{type:"url",value:"urn:vectra:"+id}]),
        ]});
      const signing=generateKeyPairSync("ed25519");
      atomicWrite(join(folder,"tls.crt"),cert.toString("pem"));atomicWrite(join(folder,"tls.key"),pem("PRIVATE KEY",await crypto.subtle.exportKey("pkcs8",keys.privateKey)));
      atomicWrite(join(folder,"signing.key"),signing.privateKey.export({format:"pem",type:"pkcs8"}).toString());atomicWrite(join(folder,"input.key"),randomBytes(32));
      nodes[id]={...this.registry.nodes[id],fingerprint:new X509Certificate(cert.toString("pem")).fingerprint256,signingPublicKey:signing.publicKey.export({format:"pem",type:"spki"}).toString(),certificateExpires:new Date(cert.notAfter).toISOString()};
    }
    atomicWrite(join(this.root,"registry.json"),canonical({...this.registry,nodes}));this.registry.nodes=nodes;this.validate();
  }
  private async addAgentIdentities() {
    const missing = (["planner", "analyst"] as const).filter(id => !this.registry.nodes[id]);
    if (!missing.length) return;
    const ca = new X509Certificate(this.ca()), alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const importKey = (file: string) => crypto.subtle.importKey("pkcs8", new Uint8Array(createPrivateKey(readFileSync(file)).export({ format: "der", type: "pkcs8" })), alg, true, ["sign"]);
    const caKey = await importKey(join(this.root, "ca.key")), nodes = { ...this.registry.nodes };
    for (const id of missing) {
      const folder = join(this.root, id); mkdirSync(folder, { recursive: true, mode: 0o700 });
      const tlsKeyPath = join(folder, "tls.key"), certPath = join(folder, "tls.crt"), signingPath = join(folder, "signing.key"), inputPath = join(folder, "input.key");
      if (!existsSync(tlsKeyPath)) {
        const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
        atomicWrite(tlsKeyPath, pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)));
      }
      const publicDer = createPublicKey(createPrivateKey(readFileSync(tlsKeyPath))).export({ format: "der", type: "spki" });
      if (!existsSync(certPath)) {
        const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(publicDer), alg, true, ["verify"]);
        const cert = await x509.X509CertificateGenerator.create({ subject: `CN=${id}`, issuer: ca.subject, publicKey, signingKey: caKey, signingAlgorithm: alg,
          notBefore: new Date(Date.now() - 60000), notAfter: new Date(Math.min(Date.now() + 365 * 86400000, Date.parse(ca.validTo))), extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]),
            new x509.SubjectAlternativeNameExtension([{ type: "dns", value: id }, { type: "url", value: `urn:vectra:${id}` }]),
          ] });
        atomicWrite(certPath, cert.toString("pem"));
      }
      const cert = new X509Certificate(readFileSync(certPath));
      if (!cert.verify(ca.publicKey) || !cert.checkHost(id) || !cert.publicKey.export({ format: "der", type: "spki" }).equals(publicDer) || Date.parse(cert.validTo) <= Date.now()) throw error("identity_invalid", "新增 Agent 的证书或密钥不匹配，已有身份与数据未替换。", 500);
      if (!existsSync(signingPath)) atomicWrite(signingPath, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString());
      if (!existsSync(inputPath)) atomicWrite(inputPath, randomBytes(32));
      if (readFileSync(inputPath).length !== 32) throw error("key_invalid", "Agent 输入密钥无效。", 500);
      nodes[id] = { id, ...identityProfile(id)!, fingerprint: cert.fingerprint256, signingPublicKey: createPublicKey(createPrivateKey(readFileSync(signingPath))).export({ format: "pem", type: "spki" }).toString(), certificateExpires: new Date(cert.validTo).toISOString() };
    }
    atomicWrite(join(this.root, "registry.json"), canonical({ ...this.registry, nodes })); this.registry.nodes = nodes;
  }
  validate(allowAgentUpgrade = false) {
    const ca = new X509Certificate(this.ca());
    if (!ca.ca || !ca.verify(ca.publicKey) || ca.fingerprint256 !== this.registry.caFingerprint || Date.parse(ca.validTo) <= Date.now()) throw error("ca_invalid", "本地 CA 验证失败。", 500);
    for (const id of IDENTITIES) { if (allowAgentUpgrade && (id === "planner" || id === "analyst") && !this.registry.nodes[id]) continue; this.validateNode(id); }
  }
  validateNode(id: string) {
    const node = this.registry.nodes[id];
    if (!IDENTITIES.includes(id as Identity) || !node || node.id !== id) throw error("identity_unknown", "身份不在登记列表。", 403);
    const cert = new X509Certificate(readFileSync(join(this.root, id, "tls.crt")));
    const ca = new X509Certificate(this.ca());
    if (!cert.verify(ca.publicKey) || cert.fingerprint256 !== node.fingerprint || !cert.checkHost(id) || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw error("identity_invalid", "证书、登记指纹或有效期校验失败。", 403);
    return node;
  }
  ca() { return readFileSync(join(this.root, "ca.crt"), "utf8"); }
  tls(id: Identity) { this.validateNode(id); return { ca: this.ca(), cert: readFileSync(join(this.root, id, "tls.crt")), key: readFileSync(join(this.root, id, "tls.key")) }; }
  nodes() { return IDENTITIES.map(id => this.validateNode(id)); }
  configureIdentities(settings: ParkSettings) {
    // Update business metadata only. Existing keys, fingerprints and signed records stay intact.
    const nodes = { ...this.registry.nodes };
    for (const id of IDENTITIES) nodes[id] = { ...this.validateNode(id), ...identityProfile(id, settings)! };
    if (canonical(nodes) !== canonical(this.registry.nodes)) {
      atomicWrite(join(this.root, "registry.json"), canonical({ ...this.registry, nodes }));
      this.registry.nodes = nodes;
    }
    return this.nodes();
  }
  storageKey() { const key = readFileSync(join(this.root, "storage.key")); if (key.length !== 32) throw error("key_invalid", "存储密钥无效。", 500); return key; }
  sign(id: Identity, payload: JsonObject): SignedEnvelope {
    const node = this.validateNode(id), key = createPrivateKey(readFileSync(join(this.root, id, "signing.key")));
    if (createPublicKey(key).export({ format: "pem", type: "spki" }).toString() !== node.signingPublicKey) throw error("key_mismatch", "签名密钥与登记身份不匹配。", 403);
    return { signer: id, payload: JSON.parse(canonical(payload)), signature: sign(null, Buffer.from(canonical(payload)), key).toString("base64url") };
  }
  verify(value: unknown, expected?: string): JsonObject {
    const env = value as SignedEnvelope;
    if (!env || typeof env.signer !== "string" || !env.payload || typeof env.payload !== "object" || Array.isArray(env.payload) || typeof env.signature !== "string") throw error("invalid_envelope", "签名信封格式无效。", 422);
    if (expected && env.signer !== expected) throw error("identity_mismatch", "签署者与预期身份不一致。", 403);
    const node = this.validateNode(env.signer);
    if (!verify(null, Buffer.from(canonical(env.payload)), createPublicKey(node.signingPublicKey), Buffer.from(env.signature, "base64url"))) throw error("signature_invalid", "Ed25519 数字签名验证失败。", 403);
    return JSON.parse(canonical(env.payload));
  }
}
function pem(label: string, bytes: ArrayBuffer) { return `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`; }

export function authorizeTask(security: Security, envelope: unknown) {
  const data = security.verify(envelope, "coordinator");
  const query = validateQuery(data.statistics);
  if (data.metric !== "aggregate_vector_v1" || data.road !== query.roads.join("、") || data.windowSeconds !== (query.end - query.start) / 1000 || typeof data.datasetVersion !== "string" || !/^[a-f0-9-]{36}$/.test(data.datasetVersion) || canonical(data.participants) !== canonical(PARTICIPANTS)
    || typeof data.taskId !== "string" || !/^[\w-]{8,100}$/.test(data.taskId)
    || typeof data.requestId !== "string" || typeof data.createdAt !== "number" || typeof data.expiresAt !== "number"
    || data.createdAt > Date.now() + 5000 || data.expiresAt <= Date.now() || data.expiresAt - data.createdAt > 120_000) throw error("unauthorized", "任务范围、参与者或有效期不符合批准策略。", 403);
  return data;
}
