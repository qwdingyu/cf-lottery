export default `<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>&#x1F388; {{drawName}} 开奖结果</h2>
  <p>您好，您参与的 <strong>{{drawName}}</strong> 已开奖。很遗憾您本次未中奖，但我们为您准备了专属优惠：</p>
  {{#if couponCode}}
  <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0; text-align: center;">
    <p style="margin: 0 0 8px 0; font-size: 12px; color: #666;">您的专属优惠券</p>
    <p style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 2px;">{{couponCode}}</p>
    {{#if couponLabel}}<p style="margin: 8px 0 0; font-size: 14px; color: #333;">{{couponLabel}}</p>{{/if}}
  </div>
  {{/if}}
  <p>关注我们的后续活动，更多好礼等着您！</p>
  {{#if nextActivityUrl}}
  <p style="margin-top: 20px;">
    <a href="{{nextActivityUrl}}" style="display: inline-block; padding: 10px 20px; background: #4f8ef7; color: #fff; text-decoration: none; border-radius: 6px;">
      查看最新活动
    </a>
  </p>
  {{/if}}
  <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;" />
  <p style="font-size: 12px; color: #999;">此邮件由系统自动发送，请勿回复。</p>
</body>
</html>`
