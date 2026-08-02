export default `<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>&#x23F0; 开奖提醒</h2>
  <p>您好，您参与的 <strong>{{drawName}}</strong> 将在 <strong>1 小时后</strong>开奖。</p>
  <p>祝您好运，期待您中奖！</p>
  {{#if shareUrl}}<p style="margin-top: 20px;">
    <a href="{{shareUrl}}" style="display: inline-block; padding: 10px 20px; background: #4f8ef7; color: #fff; text-decoration: none; border-radius: 6px;">
      邀请好友，增加抽奖机会
    </a>
  </p>{{/if}}
  <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;" />
  <p style="font-size: 12px; color: #999;">此邮件由系统自动发送，请勿回复。</p>
</body>
</html>`
