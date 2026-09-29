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
  'MTL': ['Montreal Canadiens', 'Montreal', 'Montréal Canadiens', 'Montréal'],
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
  });
  const page = await context.newPage();

  await page.goto('https://onhockey.tv/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);

  const rawGames = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    document.querySelectorAll('div.gamelinks').forEach(div => {
      const td = div.closest('td');
      if (!td) return;

      const firstLine = td.innerText.split('\n')[0].trim();
      if (!firstLine) return;

      const timeMatch = firstLine.match(/^(\d{1,2}:\d{2})\s*/);
      const time = timeMatch ? timeMatch[1] : '';
      const withoutTime = firstLine.replace(/^\d{1,2}:\d{2}\s*/, '');

      const parts = withoutTime.split(/\s+-\s+/);
      if (parts.length < 2) return;
      const away = parts[0].trim();
      const home = parts[1].trim();
      if (!away || !home) return;

      const key = `${time}|${away}|${home}`;
      if (seen.has(key)) return;
      seen.add(key);

      const internalLink = div.querySelector('a[href*="np_stream"], a[href*="np_youtube"]');
      if (!internalLink) return;

      const href = internalLink.getAttribute('href');
      const playerUrl = href.startsWith('http')
        ? href
        : 'https://onhockey.tv/' + href.replace(/^\//, '');

      let channel = '';
      try {
        channel = new URL(playerUrl).searchParams.get('channel') || '';
      } catch (_) {}

      results.push({
        away, home, time, playerUrl, channel,
        linkType: href.includes('np_youtube') ? 'youtube' : 'internal',
        rawFirstLine: firstLine,
      });
    });

    return results;
  });

  await browser.close();

  // Filter to NHL games (both teams must resolve)
  const nhlGames = rawGames
    .map(g => ({ ...g, awayAbbr: resolveTeam(g.away), homeAbbr: resolveTeam(g.home) }))
    .filter(g => g.awayAbbr && g.homeAbbr);

  console.log(`Scraped ${rawGames.length} total games; ${nhlGames.length} NHL games`);

  if (nhlGames.length === 0) {
    console.log('No NHL games right now — nothing to write.');
    return;
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
  const today = new Date().toISOString().slice(0, 10);
  const tabName = today;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabExists = meta.data.sheets.some(s => s.properties.title === tabName);

  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
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