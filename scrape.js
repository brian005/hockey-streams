const { chromium } = require('playwright');
const { google } = require('googleapis');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://onhockey.tv/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const games = await page.evaluate(() => {
  const results = [];

  document.querySelectorAll('div.gamelinks').forEach(div => {
    const td = div.closest('td');
    const tr = td ? td.closest('tr') : null;
    if (!td || !tr) return;

    // Get the first line of the td — that's [time][Team A - Team B]
    const firstLine = td.innerText.split('\n')[0].trim();

    // Strip leading time like "08:30" (with or without trailing space)
    const withoutTime = firstLine.replace(/^\d{1,2}:\d{2}\s*/, '');

    // Split on " - " to get teams
    const parts = withoutTime.split(/\s+-\s+/);
    const away = parts[0] || '';
    const home = parts[1] || '';

    // Time (optional)
    const timeMatch = firstLine.match(/^(\d{1,2}:\d{2})/);
    const time = timeMatch ? timeMatch[1] : '';

    // Look for an OnHockey internal player link inside this game's div
    const internalLink = div.querySelector('a[href*="np_stream"], a[href*="np_youtube"]');

    // Also collect any external links (sportplus, vertex, etc.)
    const externalLinks = Array.from(div.querySelectorAll('a[href^="//"], a[href^="http"]'))
      .map(a => a.href)
      .filter(h => !h.includes('onhockey.tv'));

    let playerUrl = '';
    let channel = '';
    let linkType = '';

    if (internalLink) {
      const href = internalLink.getAttribute('href');
      playerUrl = href.startsWith('http') ? href : 'https://onhockey.tv/' + href.replace(/^\//, '');
      try {
        channel = new URL(playerUrl).searchParams.get('channel') || '';
      } catch (_) {}
      linkType = href.includes('np_youtube') ? 'youtube' : 'internal';
    } else if (externalLinks.length > 0) {
      playerUrl = externalLinks[0];
      linkType = 'external';
    }

    results.push({
      away,
      home,
      time,
      playerUrl,
      channel,
      linkType,
      rawFirstLine: firstLine,
    });
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
  ['Away', 'Home', 'Channel', 'Player URL', 'Link Type', 'Raw Text', 'Scraped At'],
  ...games.map(g => [
    g.away,
    g.home,
    g.channel,
    g.playerUrl,
    g.linkType,
    g.rawText,
    new Date().toISOString()
  ]),
];

  console.log(`Wrote ${rows.length - 1} games to ${tabName}`);
}

main().catch(err => { console.error(err); process.exit(1); });