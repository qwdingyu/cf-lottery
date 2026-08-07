/**
 * 支付 Provider 目录（照搬 cf-shop 的 catalog.ts 模式，provider 换成 cf-core 内置）
 *
 * 定义每个支付渠道的元数据（显示名、字段、敏感位），供 L2 后台配置 UI 渲染。
 */
import type { ProviderFactory } from "@usethink/cf-core/features/payment";
import { stripeFactory, alipayFactory, trc20Factory } from "@usethink/cf-core/features/payment";
// ── 待 @usethink/cf-core 0.4.17+ 发布后取消注释（已提交至 cf-core git main，npm 发布中） ──
// import { easyPayFactory } from "@usethink/cf-core/features/payment/providers/easypay";

export type ProviderFieldMeta = {
  key: string;
  label: string;
  type?: "text" | "password" | "url";
  required: boolean;
  sensitive: boolean;
  placeholder?: string;
  hint?: string;
};

export type PaymentProviderCatalogItem = {
  name: string;
  displayName: string;
  description: string;
  supportedCurrencies: readonly string[];
  factory: ProviderFactory;
  fields: ProviderFieldMeta[];
};

export const PAYMENT_PROVIDER_CATALOG = [
  {
    name: "stripe",
    displayName: "Stripe",
    description: "国际信用卡/Apple Pay/Google Pay，API 简单，支持全球收款",
    supportedCurrencies: ["usd", "eur", "cny"] as const,
    factory: stripeFactory,
    fields: [
      { key: "STRIPE_SECRET_KEY", label: "Secret Key", type: "password", required: true, sensitive: true, placeholder: "sk_live_..." },
      { key: "STRIPE_WEBHOOK_SECRET", label: "Webhook Secret", type: "password", required: true, sensitive: true, placeholder: "whsec_..." },
    ],
  },
  {
    name: "alipay",
    displayName: "支付宝",
    description: "支付宝当面付/H5，国内主流支付",
    supportedCurrencies: ["cny"] as const,
    factory: alipayFactory,
    fields: [
      { key: "ALIPAY_APP_ID", label: "App ID", required: true, sensitive: false },
      { key: "ALIPAY_PRIVATE_KEY", label: "应用私钥", type: "password", required: true, sensitive: true },
      { key: "ALIPAY_PUBLIC_KEY", label: "支付宝公钥", type: "password", required: true, sensitive: true },
    ],
  },
  {
    name: "usdt_trc20",
    displayName: "USDT-TRC20",
    description: "USDT-TRC20 加密货币收款（TronGrid API）",
    supportedCurrencies: ["usdt"] as const,
    factory: trc20Factory,
    fields: [
      { key: "TRC20_WALLET_ADDRESS", label: "钱包地址", required: true, sensitive: false, placeholder: "T..." },
      { key: "TRONGRID_API_KEY", label: "TronGrid API Key", type: "password", required: true, sensitive: true },
    ],
  },
  // ── 待 @usethink/cf-core 0.4.17+ 发布后取消注释，并取消上方 import 的注释 ──
  // {
  //   name: "easypay",
  //   displayName: "易支付",
  //   description: "对接所有兼容易支付协议的聚合网关，包括 ZPay；支持支付宝、微信和 QQ 支付",
  //   supportedCurrencies: ["cny"] as const,
  //   factory: easyPayFactory,
  //   fields: [
  //     { key: "EASYPAY_PID", label: "商户PID", required: true, sensitive: false },
  //     { key: "EASYPAY_KEY", label: "商户密钥", type: "password", required: true, sensitive: true },
  //     { key: "EASYPAY_API_BASE", label: "易支付接口地址", type: "url", required: true, sensitive: false, placeholder: "https://zpayz.cn" },
  //     { key: "EASYPAY_RETURN_URL", label: "支付后跳转URL（可选）", type: "url", required: false, sensitive: false },
  //     { key: "EASYPAY_PAY_TYPE", label: "默认收款方式", required: false, sensitive: false, placeholder: "alipay" },
  //     { key: "EASYPAY_ENABLED_PAY_TYPES", label: "启用收款方式", required: false, sensitive: false, placeholder: "alipay,wxpay,qqpay" },
  //   ],
  // },
] satisfies PaymentProviderCatalogItem[];

export const PAYMENT_PROVIDER_FACTORIES = PAYMENT_PROVIDER_CATALOG.map((item) => item.factory);
export const VALID_PROVIDER_NAMES = PAYMENT_PROVIDER_CATALOG.map((item) => item.name) as Array<ValidProviderName>;

export type ValidProviderName = typeof PAYMENT_PROVIDER_CATALOG[number]["name"];

export function getProviderMeta(name: string): PaymentProviderCatalogItem | undefined {
  return PAYMENT_PROVIDER_CATALOG.find((item) => item.name === name);
}

export function isValidProviderName(name: string): name is ValidProviderName {
  return PAYMENT_PROVIDER_CATALOG.some((item) => item.name === name);
}
