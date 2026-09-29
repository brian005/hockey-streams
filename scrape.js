const { chromium } = require('playwright');
const { google } = require('googleapis');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://onhockey.tv/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const games = await page.evaluate(() => {
    const results = [];
    // ⚠️ Replace this selector with the real one after inspecting the page
    document.querySelectorAll('a[href*="np_stream"]').forEach(link => {
      const href = link.getAttribute('href');
      if (href && href.includes('channel=')) {
        const channel = new URL('https://onhockey.tv' + href).searchParams.get('channel');
        const text = link.closest('tr, div, li')?.innerText || '';
        const match = text.match(/([A-Za-z\s]+)\s*@\s*([A-Za-z\s]+)/);
        if (channel) {
          results.push({
            away: match ? match[1].trim() : '',
            home: match ? match[2].trim() : '',
            channel,
            streamUrl: 'https://onhockey.tv' + href
          });
        }
      }
    });
    return results;
  });

  await browser.close();
  console.log(`Scraped ${games.length} games`);

  if (games.length === 0) {
    console.error('Zero games found — selector is likely broken or IP is blocked');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GSHEET_CLIENT_EMAIL,
      private_key: process.env.GSHEET_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const tabName = 'Today';

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tabName}!A:Z`,
  });

  const rows = [
    ['Away', 'Home', 'Channel', 'Stream URL', 'Scraped At'],
    ...games.map(g => [g.away, g.home, g.channel, g.streamUrl, new Date().toISOString()]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  console.log(`Wrote ${rows.length - 1} games to ${tabName}`);
}

main().catch(err => { console.error(err); process.exit(1); });