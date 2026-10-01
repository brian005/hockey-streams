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
  'LAK': ['Los Angeles Kings', 'Los Angeles', 'LA Kings', 'LA'],
  'MIN': ['Minnesota Wild', 'Minnesota'],
  'MTL': ['Montreal Canadiens', 'Montreal', 'Montréal Canadiens', 'Montréal'],
  'NSH': ['Nashville Predators', 'Nashville'],
  'NJD': ['New Jersey Devils', 'New Jersey', 'NJ Devils', 'NJ'],
  'NYI': ['New York Islanders', 'Islanders', 'NY Islanders'],
  'NYR': ['New York Rangers', 'Rangers', 'NY Rangers'],
  'OTT': ['Ottawa Senators', 'Ottawa'],
  'PHI': ['Philadelphia Flyers', 'Philadelphia'],
  'PIT': ['Pittsburgh Penguins', 'Pittsburgh'],
  'SJS': ['San Jose Sharks', 'San Jose', 'SJ Sharks', 'SJ'],
  'SEA': ['Seattle Kraken', 'Seattle'],
  'STL': ['St. Louis Blues', 'St Louis Blues', 'St. Louis', 'St Louis'],
  'TBL': ['Tampa Bay Lightning', 'Tampa Bay', 'TB Lightning', 'TB'],
  'TOR': ['Toronto Maple Leafs', 'Toronto'],
  'UTA': ['Utah Hockey Club', 'Utah', 'Utah HC'],
  'VAN': ['Vancouver Canucks', 'Vancouver'],
  'VGK': ['Vegas Golden Knights', 'Vegas'],
  'WSH': ['Washington Capitals', 'Washington'],
  'WPG': ['Winnipeg Jets', 'Winnipeg'],
};

// Only these stream names are kept. Everything else is dropped.
const WANTED_STREAMS = ['asiria', 'timst', 'slevel', 'fluidtv', 'wcaster', 'alieztv', 'lovecdn'];

function resolveTeam(name) {
  const n = (name || '').trim();
  if (!n) return null;
  for (const [abbr, aliases] of Object.entries(NHL_ALIASES)) {
    if (aliases.some(a => a.toLowerCase() === n.toLowerCase())) return abbr;
  }
  return null;
}

// Convert "HH:MM" (UTC, today's date) to "HH:MM" in Vancouver (PT).
function utcHHMMToVancouver(utcHHMM) {
  if (!utcHHMM || !/^\d{1,2}:\d{2}$/.test(utcHHMM)) return utcHHMM;

  const utcToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const [hh, mm] = utcHHMM.split(':').map(Number);
  const [yyyy, mo, dd] = utcToday.split('-').map(Number);

  const utcMs = Date.UTC(yyyy, mo - 1, dd, hh, mm);

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Vancouver',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(utcMs));
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

  const SCHEDULE_URL = 'https://onhockey.tv/schedule_table.php?_=' + Date.now();
  console.log('Fetching:', SCHEDULE_URL);

  const response = await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const status = response ? response.status() : 'no response';
  const htmlLength = await page.evaluate(() => document.documentElement.innerHTML.length);
  console.log(`HTTP status: ${status}, HTML length: ${htmlLength}`);

  const games = await page.evaluate((wantedNames) => {
    const results = [];
    const seen = new Set();

    document.querySelectorAll('tr.game').forEach(tr => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 2) return;

      const time = (cells[0].innerText || '').trim();
      const teamsText = (cells[1].innerText || '').trim();
      if (!teamsText) return;

      const parts = teamsText.split(/\s+-\s+/);
      if (parts.length < 2) return;
      const away = parts[0].trim();
      const home = parts[1].trim();
      if (!away || !home) return;

      const key = `${time}|${away}|${home}`;
      if (seen.has(key)) return;
      seen.add(key);

      // Collect only the wanted stream names, in DOM order
      const streams = [];
      tr.querySelectorAll('a[href*="np_stream"], a[href*="np_youtube"]').forEach(a => {
        const rawName = (a.textContent || '').trim();
        const matchName = rawName.toLowerCase().replace(/:$/, '');
        if (!wantedNames.includes(matchName)) return;
        const href = a.getAttribute('href');
        const url = href.startsWith('http') ? href : 'https://onhockey.tv/' + href.replace(/^\//, '');
        streams.push({ name: rawName, url });
      });

      results.push({
        away, home, time,
        streams: streams.slice(0, 10),
        rawFirstLine: `${time}\t${teamsText}`,
      });
    });

    return results;
  }, WANTED_STREAMS);

  console.log(`Found ${games.length} games`);

  if (games.length === 0) {
    console.log('--- DEBUG: DOM structure dump ---');
    const structure = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('tr')).slice(0, 10);
      return trs.map(tr => ({
        class: tr.className || '(none)',
        tdCount: tr.querySelectorAll('td').length,
        firstTdText: (tr.querySelector('td')?.innerText || '').slice(0, 100).replace(/\n/g, ' | '),
        trText: (tr.innerText || '').slice(0, 100).replace(/\n/g, ' | '),
      }));
    });
    console.log(JSON.stringify(structure, null, 2));
    await browser.close();
    console.error('Zero games parsed — see debug dump above');
    process.exit(1);
  }

  await browser.close();

  // Convert times from UTC (OnHockey) to Vancouver (PT)
  games.forEach(g => {
    g.timeUTC = g.time;
    g.timeVancouver = utcHHMMToVancouver(g.time);
  });

  const nhlGames = games
    .map(g => ({ ...g, awayAbbr: resolveTeam(g.away), homeAbbr: resolveTeam(g.home) }))
    .filter(g => g.awayAbbr && g.homeAbbr);

  console.log(`Scraped ${games.length} total games; ${nhlGames.length} NHL games`);
  nhlGames.forEach(g => {
    console.log(`  ${g.timeVancouver} PT (${g.timeUTC} UTC) | ${g.awayAbbr} @ ${g.homeAbbr} | streams=${g.streams.length}`);
  });

  if (nhlGames.length === 0) {
    console.log('No NHL games right now — nothing to write.');
    return;
  }

  const maxStreams = Math.min(10, Math.max(1, ...nhlGames.map(g => g.streams.length)));

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GSHEET_CLIENT_EMAIL,
      private_key: process.env.GSHEET_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabExists = meta.data.sheets.some(s => s.properties.title === today);

  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: today } } }] },
    });
    console.log(`Created tab "${today}"`);
  } else {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${today}!A:Z`,
    });
  }

  // Build header: Away, Home, Abbrs, Time (PT), Time (UTC), then Stream N Name / Stream N URL pairs,
  // then Stream Count, Raw Text, Scraped At
  const streamHeaders = [];
  for (let i = 1; i <= maxStreams; i++) {
    streamHeaders.push(`Stream ${i} Name`, `Stream ${i} URL`);
  }
  const header = [
    'Away', 'Home', 'Away Abbr', 'Home Abbr',
    'Time (PT)', 'Time (UTC)',
    ...streamHeaders,
    'Stream Count', 'Raw Text', 'Scraped At',
  ];

  const rows = [
    header,
    ...nhlGames.map(g => {
      const streamCells = [];
      for (let i = 0; i < maxStreams; i++) {
        const s = g.streams[i];
        streamCells.push(s ? s.name : '', s ? s.url : '');
      }
      return [
        g.away, g.home, g.awayAbbr, g.homeAbbr,
        g.timeVancouver, g.timeUTC,
        ...streamCells,
        g.streams.length,
        g.rawFirstLine,
        new Date().toISOString(),
      ];
    }),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${today}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  console.log(`Wrote ${rows.length - 1} NHL games with up to ${maxStreams} streams each to tab "${today}"`);
}

main().catch(err => { console.error(err); process.exit(1); });