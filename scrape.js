const { chromium } = require('playwright');
const { google } = require('googleapis');

const NHL_ALIASES = {
  'ANA': ['Anaheim Ducks', 'Anaheim'],
  'BOS': ['Boston Bruins', 'Boston'],
  'BUF': ['Buffalo Sabres', 'Buffalo'],
  'CGY': ['Calgary Flames', 'Calgary'],
  'CAR': ['Carolina Hurricanes', 'Carolina'],
  'CHI': ['Chicago Blackhawks', 'Chicago'],
  'COL': ['Colorado Avalanche', 'Colorado'],
  'CBJ': ['Columbus Blue Jackets', 'Columbus'],
  'DAL': ['Dallas Stars', 'Dallas'],
  'DET': ['Detroit Red Wings', 'Detroit'],
  'EDM': ['Edmonton Oilers', 'Edmonton'],
  'FLA': ['Florida Panthers', 'Florida'],
  'LAK': ['Los Angeles Kings', 'Los Angeles', 'LA Kings'],
  'MIN': ['Minnesota Wild', 'Minnesota'],
  'MTL': ['Montreal Canadiens', 'Montreal', 'Montréal Canadiens', 'Montréal', 'Montréal Canadiens'],
  'NSH': ['Nashville Predators', 'Nashville'],
  'NJD': ['New Jersey Devils', 'New Jersey'],
  'NYI': ['New York Islanders', 'Islanders'],
  'NYR': ['New York Rangers', 'Rangers'],
  'OTT': ['Ottawa Senators', 'Ottawa'],
  'PHI': ['Philadelphia Flyers', 'Philadelphia'],
  'PIT': ['Pittsburgh Penguins', 'Pittsburgh'],
  'SJS': ['San Jose Sharks', 'San Jose'],
  'SEA': ['Seattle Kraken', 'Seattle'],
  'STL': ['St. Louis Blues', 'St Louis Blues', 'St. Louis', 'St Louis'],
  'TBL': ['Tampa Bay Lightning', 'Tampa Bay'],
  'TOR': ['Toronto Maple Leafs', 'Toronto'],
  'UTA': ['Utah Hockey Club', 'Utah', 'Utah HC'],
  'VAN': ['Vancouver Canucks', 'Vancouver'],
  'VGK': ['Vegas Golden Knights', 'Vegas'],
  'WSH': ['Washington Capitals', 'Washington'],
  'WPG': ['Winnipeg Jets', 'Winnipeg'],
};

function resolveTeam(name) {
  const n = (name || '').trim();
  if (!n) return null;
  for (const [abbr, aliases] of Object.entries(NHL_ALIASES)) {
    if (aliases.some(a => a.toLowerCase() === n.toLowerCase())) return abbr;
  }
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    extraHTTPHeaders: {
      'Referer': 'https://onhockey.tv/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const page = await context.newPage();

  // Hit the schedule endpoint directly. Retry if we get a stripped response.
  const SCHEDULE_URL = 'https://onhockey.tv/schedule_table.php?_=' + Date.now();

  let games = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`Attempt ${attempt}: fetching ${SCHEDULE_URL}`);
    const response = await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = response ? response.status() : 'no response';
    const htmlLength = await page.evaluate(() => document.documentElement.innerHTML.length);
    console.log(`  HTTP status: ${status}, HTML length: ${htmlLength}`);

    games = await page.evaluate(() => {
  const results = [];
  const seen = new Set();

  // Iterate every row in the schedule table. A game row is one whose
  // first cell text starts with a time like "22:00" or "03:30".
  document.querySelectorAll('tr').forEach(tr => {
    const td = tr.querySelector('td');
    if (!td) return;

    const text = td.innerText.trim();
    if (!text) return;

    // Must start with a time "HH:MM"
    const timeMatch = text.match(/^(\d{1,2}:\d{2})\s*/);
    if (!timeMatch) return;

    const time = timeMatch[1];
    const firstLine = text.split('\n')[0].trim();
    const withoutTime = firstLine.replace(/^\d{1,2}:\d{2}\s*/, '');

    const parts = withoutTime.split(/\s+-\s+/);
    if (parts.length < 2) return;
    const away = parts[0].trim();
    const home = parts[1].trim();
    if (!away || !home) return;

    const key = `${time}|${away}|${home}`;
    if (seen.has(key)) return;
    seen.add(key);

    // Optional: does this game have a stream link right now?
    const gamelinks = td.querySelector('div.gamelinks');
    const internalLink = gamelinks
      ? gamelinks.querySelector('a[href*="np_stream"], a[href*="np_youtube"]')
      : null;

    let playerUrl = '';
    let channel = '';
    let linkType = 'none';

    if (internalLink) {
      const href = internalLink.getAttribute('href');
      playerUrl = href.startsWith('http')
        ? href
        : 'https://onhockey.tv/' + href.replace(/^\//, '');
      try {
        channel = new URL(playerUrl).searchParams.get('channel') || '';
      } catch (_) {}
      linkType = href.includes('np_youtube') ? 'youtube' : 'internal';
    }

    results.push({
      away, home, time, playerUrl, channel, linkType,
      rawFirstLine: firstLine,
    });
  });

  return results;
});

    console.log(`  Found ${games.length} games`);
    if (games.length > 0) break;

    // Debug dump on empty result
    const bodyPreview = await page.evaluate(() => document.body.innerText.slice(0, 600));
    console.log('  Body preview:\n' + bodyPreview);

    if (attempt < 4) {
      await page.waitForTimeout(3000);
    }
  }

  await browser.close();

  if (games.length === 0) {
    console.error('Zero games after 4 attempts — OnHockey is returning stripped pages to this IP');
    process.exit(1);
  }

  // Filter to NHL games
  const nhlGames = games
    .map(g => ({ ...g, awayAbbr: resolveTeam(g.away), homeAbbr: resolveTeam(g.home) }))
    .filter(g => g.awayAbbr && g.homeAbbr);

  console.log(`Scraped ${games.length} total games; ${nhlGames.length} NHL games`);

  if (nhlGames.length === 0) {
    console.log('No NHL games right now — nothing to write.');
    return;
  }

  // Write to Google Sheets
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GSHEET_CLIENT_EMAIL,
      private_key: process.env.GSHEET_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const today = new Date().toISOString().slice(0, 10);
  const tabName = today;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabExists = meta.data.sheets.some(s => s.properties.title === tabName);

  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    console.log(`Created tab "${tabName}"`);
  } else {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${tabName}!A:Z`,
    });
  }

  const rows = [
    ['Away', 'Home', 'Away Abbr', 'Home Abbr', 'Time', 'Link Type', 'Player URL', 'Channel', 'Raw Text', 'Scraped At'],
    ...nhlGames.map(g => [
      g.away, g.home, g.awayAbbr, g.homeAbbr, g.time,
      g.linkType, g.playerUrl, g.channel, g.rawFirstLine,
      new Date().toISOString(),
    ]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  console.log(`Wrote ${rows.length - 1} NHL games to tab "${tabName}"`);
}

main().catch(err => { console.error(err); process.exit(1); });