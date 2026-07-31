/** 商品合同类型（cf-lottery 简化版） */
export type ProductContract = { id: string; title: string }
export type DeliveryVisibility = 'web_and_email' | 'email_only' | 'web_only'
export type StockDisplayMode = 'none' | 'low_stock' | 'exact'
