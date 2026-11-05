import { describe, expect, it } from 'vitest';

import {
  applyCertificateVerifyPolicy,
  type CertificateBypassRecord,
  type CertificateVerifyProc,
  type CertificateVerifyRequest,
  type CertificateVerifySession,
} from '../../../src/main/network/cert-policy';

/**
 * 不受信任证书放行策略测试。
 *
 * 规则来源：规格 v2.1.7 §7（`network.allowUntrustedCertificates` 默认关闭、
 * 全部证书错误一律放行、仅作用于远程业务会话）、§12（`certificate-error-accepted`
 * 诊断只含主机名与校验结果）与 `rules/security.md`「证书校验绕过只允许经显式
 * 配置开关按会话启用」。
 *
 * 假 session 只录制 `setCertificateVerifyProc` 的注册与恢复，不触碰真实
 * Chromium 网络栈（`rules/testing-release.md`：Electron API 经注入端口测试）。
 */
class FakeSession implements CertificateVerifySession {
  /** 注册历史；最后一次为当前生效过程，`null` 表示恢复 Chromium 默认校验。 */
  readonly registrations: Array<CertificateVerifyProc | null> = [];

  setCertificateVerifyProc(proc: CertificateVerifyProc | null): void {
    this.registrations.push(proc);
  }

  get activeProc(): CertificateVerifyProc | null {
    return this.registrations.length === 0 ? null : this.registrations[this.registrations.length - 1];
  }
}

function verifyRequest(overrides: Partial<CertificateVerifyRequest> = {}): CertificateVerifyRequest {
  return { hostname: 'erp.internal', verificationResult: 'CERT_AUTHORITY_INVALID', errorCode: -202, ...overrides };
}

/** 经当前生效校验过程执行一次校验，返回 callback 收到的结果码。 */
function runVerification(session: FakeSession, request: CertificateVerifyRequest): number {
  const proc = session.activeProc;
  if (proc === null) throw new Error('当前未注册证书校验过程');
  let result = Number.NaN;
  proc(request, (verificationResult) => {
    result = verificationResult;
  });
  return result;
}

describe('applyCertificateVerifyPolicy（规格 v2.1.7 §7）', () => {
  it('开启时安装校验过程，放行（callback(0)）并记录主机名与校验结果', () => {
    const session = new FakeSession();
    const records: CertificateBypassRecord[] = [];

    const applied = applyCertificateVerifyPolicy(session, true, {
      onBypass: (record) => records.push(record),
    });

    expect(applied).toEqual({ installed: true });
    expect(session.activeProc).not.toBeNull();

    expect(runVerification(session, verifyRequest())).toBe(0);
    expect(records).toEqual([
      { hostname: 'erp.internal', verificationResult: 'CERT_AUTHORITY_INVALID', errorCode: -202 },
    ]);
  });

  it('校验通过（verificationResult=OK）时同样放行但不记录放行事件', () => {
    const session = new FakeSession();
    const records: CertificateBypassRecord[] = [];

    applyCertificateVerifyPolicy(session, true, { onBypass: (record) => records.push(record) });

    expect(runVerification(session, verifyRequest({ verificationResult: 'OK', errorCode: 0 }))).toBe(0);
    expect(records).toEqual([]);
  });

  it('全部证书错误一律放行（自签名、吊销、过期、主机名不匹配、弱签名、名称约束）', () => {
    const session = new FakeSession();
    const records: CertificateBypassRecord[] = [];

    applyCertificateVerifyPolicy(session, true, { onBypass: (record) => records.push(record) });

    const failures = [
      'CERT_AUTHORITY_INVALID',
      'CERT_REVOKED',
      'CERT_DATE_INVALID',
      'CERT_COMMON_NAME_INVALID',
      'CERT_WEAK_SIGNATURE_ALGORITHM',
      'CERT_WEAK_KEY',
      'CERT_NAME_CONSTRAINT_VIOLATION',
      'CERT_INVALID',
    ];
    for (const verificationResult of failures) {
      expect(runVerification(session, verifyRequest({ verificationResult, errorCode: -201 }))).toBe(0);
    }
    expect(records).toHaveLength(failures.length);
    expect(records.every((record) => record.hostname === 'erp.internal')).toBe(true);
  });

  it('关闭时恢复 Chromium 默认校验（setCertificateVerifyProc(null)）', () => {
    const session = new FakeSession();

    applyCertificateVerifyPolicy(session, true);
    applyCertificateVerifyPolicy(session, false);

    expect(session.activeProc).toBeNull();
    expect(session.registrations).toHaveLength(2);
  });

  it('默认关闭：未开启时不注册任何校验过程，行为与升级前一致', () => {
    const session = new FakeSession();

    const applied = applyCertificateVerifyPolicy(session, false);

    expect(applied).toEqual({ installed: false });
    expect(session.registrations).toEqual([null]);
  });

  it('重复应用幂等：仅最后一次注册生效', () => {
    const session = new FakeSession();

    applyCertificateVerifyPolicy(session, true);
    applyCertificateVerifyPolicy(session, true);
    applyCertificateVerifyPolicy(session, false);
    applyCertificateVerifyPolicy(session, false);

    expect(session.registrations).toHaveLength(4);
    expect(session.activeProc).toBeNull();
  });

  it('未提供 onBypass 时不因记录放行事件而抛错', () => {
    const session = new FakeSession();

    applyCertificateVerifyPolicy(session, true);

    expect(() => runVerification(session, verifyRequest())).not.toThrow();
  });

  it('放行记录只含主机名，不含完整网址与查询参数（规格 §12 脱敏）', () => {
    const session = new FakeSession();
    const records: CertificateBypassRecord[] = [];

    applyCertificateVerifyPolicy(session, true, { onBypass: (record) => records.push(record) });
    runVerification(session, verifyRequest({ hostname: 'erp.internal' }));

    expect(Object.keys(records[0]).sort()).toEqual(['errorCode', 'hostname', 'verificationResult']);
  });
});
