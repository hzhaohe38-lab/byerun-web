import { MD5 } from 'crypto-js';
import { appConfig } from './config';

export function genSign(query = null, body = null) {
  const appKey = appConfig.auth.appKey;
  const appSecret = appConfig.auth.appSecret;
  let signStr = "";
  // 处理查询参数
  if (query !== null) {
    const normalizedQuery = Object.entries(query).reduce((acc, [key, value]) => {
      acc[key] = value === null ? "" : String(value);
      return acc;
    }, {});
    const sortedKeys = Object.keys(normalizedQuery).sort();
    for (const key of sortedKeys) {
      const value = normalizedQuery[key];
      if (value !== "") {
        signStr += key + value;
      }
    }
  }
  // 添加 APPKEY 和 APPSECRET
  signStr += appKey;
  signStr += appSecret;
  // 添加请求体
  if (body !== null) {
    signStr += JSON.stringify(body);
  }
  // 处理特殊字符
  let replaced = false;
  const specialChars = [" ", "~", "!", "(", ")", "'"];
  for (const ch of specialChars) {
    if (signStr.includes(ch)) {
      // 转义正则元字符再构造，避免 "(" / ")" 使 new RegExp 抛错（与 server/index.js 一致）
      const escaped = ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      signStr = signStr.replace(new RegExp(escaped, "g"), "");
      replaced = true;
    }
  }
  if (replaced) {
    signStr = encodeURIComponent(signStr);
  }
  // 生成 MD5 签名
  let sign = MD5(signStr).toString().toUpperCase();
  if (replaced) {
    sign += "encodeutf8";
  }
  return sign;
}