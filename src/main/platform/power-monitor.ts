/** 电源端口抽象：记录休眠/唤醒诊断，并在唤醒后由控制器重载目标页面（规格 §14.1）。 */
export interface PowerMonitorPort {
  onSuspend: (handler: () => void) => void;
  onResume: (handler: () => void) => void;
  removeAllListeners: () => void;
}

