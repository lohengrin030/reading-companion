import { config } from '../config.js';
import * as deepseek from './deepseek.js';

// 注册所有可用的 AI 提供商。换模型时在这里加一行 + 新建对应文件。
const providers = {
  deepseek,
};

export function getProvider(name = config.aiProvider) {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`未知的 AI 提供商: ${name}，请在 backend/.env 的 AI_PROVIDER 中配置`);
  }
  return provider;
}
