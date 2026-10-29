/**
 * 本地配置窗口的最小 preload 入口。
 *
 * 规则来源：规格 v2.1.1 §11 与 `rules/security.md`「远程内容隔离」：
 * - preload 只在本地配置窗口启用；
 * - 远程业务窗口不得加载本文件，也不得因此获得任何 IPC 能力；
 * - 暴露面固定为六个具名、类型化方法（配置读取/校验/保存/重置、连通性测试、图标选择），
 *   没有通用发送能力。
 *
 * 白名单与桥构造在 `./config-bridge` 中（纯 TypeScript，可测试），
 * 本文件只负责把 Electron API 注入进去。
 */

import { contextBridge, ipcRenderer } from 'electron';

import { installConfigBridge } from './config-bridge';

installConfigBridge({ contextBridge, ipcRenderer });
