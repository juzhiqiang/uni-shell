/**
 * 不受信任证书放行策略。
 *
 * 规则来源：规格 v2.1.7 §7（`network.allowUntrustedCertificates`）、§11
 * （证书校验绕过只允许经显式开关按会话启用）、§12（`certificate-policy-applied`
 * 与 `certificate-error-accepted` 诊断）与 `rules/security.md`「会话分区与策略隔离」。
 *
 * 背景：内网业务系统的 HTTPS 证书常为自行生成（自签名或内网 CA 未进系统信任库）。
 * Chromium 校验失败时 `loadURL` 直接失败，页面永远打不开，离线页与重试机制只会
 * 反复失败。开启该选项后，远程业务会话的全部 TLS 证书校验一律放行。
 *
 * 实现选型（Electron 45）：
 * - `session.setCertificateVerifyProc`：按会话生效，覆盖主窗口主框架、页面子资源
 *   与主进程经该会话发起的请求（断网恢复的 HEAD 探测）；传 `null` 恢复 Chromium
 *   默认校验，因此默认关闭时行为与升级前完全一致；
 * - 不用 `app.on('certificate-error')`：进程级事件、无法归因会话，主进程探测请求
 *   还拿不到 webContents；
 * - 不用命令行 `--ignore-certificate-errors`：全局生效（含本地配置会话），且需在
 *   app ready 前设置。
 *
 * 边界：只允许作用于远程业务会话 `persist:remote`；本地配置会话 `local-config`
 * 始终使用系统默认校验。Electron API 经最小结构化端口注入，测试不依赖真实 Session。
 */

/** `setCertificateVerifyProc` 的请求面（Electron `Request` 子集）。 */
export interface CertificateVerifyRequest {
  /** 发起校验的主机名（不含路径与查询，供诊断记录）。 */
  hostname: string;
  /** `OK` 表示校验通过；否则为 `CERT_AUTHORITY_INVALID`、`CERT_REVOKED` 等结果。 */
  verificationResult: string;
  /** Chromium 网络错误码（如 `-202`）。 */
  errorCode: number;
}

/** 证书校验过程：`callback(0)` 放行，`callback(-2)` 拒绝。 */
export type CertificateVerifyProc = (
  request: CertificateVerifyRequest,
  callback: (verificationResult: number) => void,
) => void;

/** 远程会话的最小使用面；真实 Electron `Session` 结构上满足该接口。 */
export interface CertificateVerifySession {
  setCertificateVerifyProc(proc: CertificateVerifyProc | null): void;
}

/**
 * 放行记录（规格 §12）：只含主机名、校验结果与错误码。
 * 不得包含完整网址——URL 可能带有查询参数（业务系统有时把令牌放在查询串里）。
 */
export interface CertificateBypassRecord {
  hostname: string;
  verificationResult: string;
  errorCode: number;
}

export interface CertificatePolicyOptions {
  /** 放行不受信任证书时的记录出口；仅在校验未通过时触发，正常放行不记录。 */
  onBypass?: (record: CertificateBypassRecord) => void;
}

/** `callback(0)`：接受证书。 */
const CERT_TRUSTED = 0;

/**
 * 安装或恢复证书放行策略（幂等）。
 *
 * - `enabled=true`：安装校验过程，对**全部**证书错误一律 `callback(0)` 放行
 *   （用户确认的产品决策：自签名、不受信任 CA、主机名不匹配、过期、弱签名、
 *   已吊销等）；校验未通过时先经 `onBypass` 记录再放行，正常通过的请求不记录；
 * - `enabled=false`：`setCertificateVerifyProc(null)` 恢复 Chromium 默认校验。
 *
 * 注意：校验结果可能被网络服务缓存——关闭开关后已放行的连接可能继续沿用放行
 * 结果，重启客户端后完全恢复默认校验（规格 §7）。
 */
export function applyCertificateVerifyPolicy(
  session: CertificateVerifySession,
  enabled: boolean,
  options: CertificatePolicyOptions = {},
): { installed: boolean } {
  if (!enabled) {
    session.setCertificateVerifyProc(null);
    return { installed: false };
  }

  session.setCertificateVerifyProc((request, callback) => {
    if (request.verificationResult !== 'OK') {
      options.onBypass?.({
        hostname: request.hostname,
        verificationResult: request.verificationResult,
        errorCode: request.errorCode,
      });
    }
    callback(CERT_TRUSTED);
  });

  return { installed: true };
}

/** 配置面的最小入参；控制器按 `network` 段整体传入。 */
export interface CertificatePolicyNetwork {
  allowUntrustedCertificates: boolean;
}

/**
 * 证书校验策略端口（仿 `ProxyPort`）：由主进程装配，控制器按生命周期调用。
 * 端口只允许在远程业务会话上生效（装配侧保证，见 `createElectronCertificatePolicyPort`）。
 */
export interface CertificatePolicyPort {
  apply(network: CertificatePolicyNetwork): { installed: boolean };
}
