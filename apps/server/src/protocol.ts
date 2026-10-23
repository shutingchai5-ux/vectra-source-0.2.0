import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProtocolSection, SignedEnvelope } from "@vectra/shared";
import { Security, canonical, hash, type Identity } from "./security";

export function identityPublic(security: Security, id: Identity): ProtocolSection[] {
  return [
    { title: `${id} · X.509 证书（PEM）`, data: readFileSync(join(security.root, id, "tls.crt"), "utf8") },
    { title: `${id} · 登记身份、指纹与 Ed25519 公钥`, data: security.validateNode(id) },
  ];
}
export function identityPrivate(security: Security, id: Identity): ProtocolSection[] {
  return [
    { title: `${id} · TLS 身份私钥（PKCS#8 PEM）`, data: readFileSync(join(security.root, id, "tls.key"), "utf8") },
    { title: `${id} · Ed25519 签名私钥（PKCS#8 PEM）`, data: readFileSync(join(security.root, id, "signing.key"), "utf8") },
  ];
}
export function signingSections(security: Security, envelope: SignedEnvelope): ProtocolSection[] {
  return [
    { title: "签名信封：签署者、完整载荷与 Base64URL 签名", data: envelope },
    { title: "RFC 8785 / JCS 规范化待签名字节（UTF-8）", data: canonical(envelope.payload) },
    { title: "载荷 SHA-256 摘要（Ed25519 对规范化原文签名）", data: hash(envelope.payload) },
    ...identityPublic(security, envelope.signer as Identity),
  ];
}
