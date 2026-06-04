const nodemailer = require('nodemailer');

async function sendDailyReport(recipients, date, excelBuffer) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString('pl-PL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  await transporter.sendMail({
    from: `"RaportRBR" <${process.env.SMTP_USER}>`,
    to: recipients.join(', '),
    subject: `📋 RaportRBR — ${dateFormatted}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#6C63FF;padding:24px;border-radius:8px 8px 0 0">
          <h1 style="color:white;margin:0;font-size:22px">RaportRBR — Raport dzienny</h1>
          <p style="color:#d4d0ff;margin:8px 0 0">${dateFormatted}</p>
        </div>
        <div style="background:#f9f9f9;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e0e0e0">
          <p>W załączniku raport zbiorczy z wykonanych prac za <strong>${dateFormatted}</strong>.</p>
          <p style="color:#888;font-size:12px;margin-top:16px">Wiadomość automatyczna — RaportRBR v1.0 © Ready Bathroom</p>
        </div>
      </div>`,
    attachments: [{
      filename: `raport_${date}.xlsx`,
      content: excelBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }],
  });
}

module.exports = { sendDailyReport };
