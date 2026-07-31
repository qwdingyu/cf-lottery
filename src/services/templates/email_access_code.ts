/**
 * 邮箱验证码邮件模板
 *
 * 用于抽奖活动参与前的邮箱验证。
 */
export default `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, sans-serif; background: #0a0e17; color: #f0f2f5; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto; background: #151b28; border-radius: 12px; padding: 32px; border: 1px solid rgba(255,255,255,0.1);">
    <h2 style="margin: 0 0 16px; font-size: 18px; color: #f59e0b;">参与验证</h2>
    <p style="margin: 0 0 8px; font-size: 14px; color: #9aa4b2;">您正在参与抽奖活动：{{drawName}}</p>
    <div style="text-align: center; margin: 24px 0;">
      <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #f59e0b; background: rgba(245,158,11,0.1); padding: 12px 24px; border-radius: 8px; font-family: monospace;">{{code}}</span>
    </div>
    <p style="margin: 0; font-size: 12px; color: #6b7280;">验证码有效期为 10 分钟，请勿泄露给他人。</p>
  </div>
</body>
</html>`;