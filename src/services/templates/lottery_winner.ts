export default `<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>🎉 恭喜中奖！奖品卡密已发放</h2>
  <p>您好，您参与的抽奖活动 <strong>{{drawName}}</strong> 已开奖，恭喜您成为中奖用户。</p>
  <p>奖品名称：{{productName}}</p>
  {{#if prizeValue}}<p>奖品价值：<strong>{{prizeValue}}</strong></p>{{/if}}
  {{#if orderNo}}<p>交付编号：{{orderNo}}（如需客服协助，请提供此编号）</p>{{/if}}
  <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
    <p style="margin: 0 0 8px 0;"><strong>奖品卡密</strong></p>
    <p style="margin: 0;"><strong>账号：</strong>{{accountLabel}}</p>
    <p style="margin: 5px 0 0 0;"><strong>密码/密钥：</strong>{{deliverySecret}}</p>
    {{#if deliveryNote}}<p style="margin: 5px 0 0 0;"><strong>备注：</strong>{{deliveryNote}}</p>{{/if}}
  </div>
  <p style="color: #888; font-size: 12px;">本邮件为抽奖中奖通知，并非购买订单。请妥善保管卡密，勿泄露给他人。</p>
</body>
</html>`;
