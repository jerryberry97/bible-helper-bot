require('dotenv').config();

// ──────────────────────────────────────────────
//  ENV VALIDATION
// ──────────────────────────────────────────────
const REQUIRED_ENV = ['TOKEN', 'CLIENT_ID'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const axios  = require('axios');
const fs     = require('fs');
const express = require('express');

// ──────────────────────────────────────────────
//  LOAD BIBLE (once, at startup)
// ──────────────────────────────────────────────
let bible = [];
let bibleFlat = []; // [{book, chapter, verse, text, textLower}]

try {
  const raw  = fs.readFileSync('./bible.json', 'utf-8').replace(/^\uFEFF/, '');
  bible      = JSON.parse(raw);

  // Pre-process into a flat array for fast O(n) search
  for (const book of bible) {
    for (let c = 0; c < book.chapters.length; c++) {
      const chapter = book.chapters[c];
      for (let v = 0; v < chapter.length; v++) {
        const text = chapter[v];
        bibleFlat.push({
          book    : book.name,
          chapter : c + 1,
          verse   : v + 1,
          text,
          textLower: text.toLowerCase(),
        });
      }
    }
  }

  console.log(`✅ Bible loaded — ${bibleFlat.length.toLocaleString()} verses indexed`);
} catch (err) {
  console.error('❌ Bible load error:', err.message);
  // Bot can still run — /ref uses the external API, /ver will just return no results
}

// ──────────────────────────────────────────────
//  SLASH COMMAND DEFINITIONS
// ──────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('ref')
    .setDescription('Fetch a Bible verse by reference')
    .addStringOption(o =>
      o.setName('reference')
       .setDescription('e.g. John 3:16  |  Genesis 1:1-3')
       .setRequired(true)
       .setMaxLength(100)
    ),

  new SlashCommandBuilder()
    .setName('ver')
    .setDescription('Find a verse by keywords')
    .addStringOption(o =>
      o.setName('text')
       .setDescription('e.g. love your enemies  |  faith hope charity')
       .setRequired(true)
       .setMaxLength(200)
    ),
].map(cmd => cmd.toJSON());

// ──────────────────────────────────────────────
//  DISCORD CLIENT
// ──────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ──────────────────────────────────────────────
//  UTILITY — Build a clean embed
// ──────────────────────────────────────────────
function verseEmbed(reference, text, color = 0x3b82f6) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: '📖 Holy Bible — KJV' })
    .setTitle(reference)
    .setDescription(text.trim())
    .setFooter({ text: 'King James Version' })
    .setTimestamp();
}

// ──────────────────────────────────────────────
//  UTILITY — Verse search (full Bible, scored)
// ──────────────────────────────────────────────
function searchVerse(rawInput) {
  const input = rawInput.toLowerCase().trim();

  // Tokenise: keep words ≥ 2 chars, remove common stop words
  const STOP = new Set([
    'the','and','for','that','this','with','have','from',
    'are','was','but','not','all','they','his','her','our',
    'you','your','him','its','their',
  ]);
  const words = input
    .split(/\s+/)
    .map(w => w.replace(/[^a-z']/g, ''))
    .filter(w => w.length >= 2 && !STOP.has(w));

  if (!words.length) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const entry of bibleFlat) {
    let score = 0;

    for (const word of words) {
      if (entry.textLower.includes(word)) score++;
    }

    // Bonus: phrase match (all words adjacent)
    if (words.length > 1 && entry.textLower.includes(input)) {
      score += words.length; // big bonus for exact phrase
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  // Require at least 1 matched keyword
  return bestScore >= 1 ? { ...bestMatch, score: bestScore } : null;
}

// ──────────────────────────────────────────────
//  UTILITY — Fetch verse from external API
// ──────────────────────────────────────────────
async function fetchVerseFromAPI(reference) {
  const url = `https://bible-api.com/${encodeURIComponent(reference)}?translation=kjv`;

  const res = await axios.get(url, {
    timeout    : 8000,
    validateStatus: s => s === 200,
  });

  const { reference: ref, text } = res.data;
  if (!ref || !text) throw new Error('Unexpected API response format');

  return { reference: ref, text };
}

// ──────────────────────────────────────────────
//  READY — Register commands once
// ──────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Global slash commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err.message);
  }
});

// ──────────────────────────────────────────────
//  INTERACTION HANDLER
// ──────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /ref ─────────────────────────────────────
  if (commandName === 'ref') {
    const reference = interaction.options.getString('reference').trim();

    await interaction.deferReply();

    try {
      const { reference: ref, text } = await fetchVerseFromAPI(reference);
      const embed = verseEmbed(ref, text);
      return await interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error(`[/ref] Error for "${reference}":`, err.message);

      const isNotFound = err.response?.status === 404 || err.message?.includes('404');
      const msg = isNotFound
        ? `❌ Reference **"${reference}"** not found.\n💡 Try a format like \`John 3:16\` or \`Genesis 1:1-3\``
        : `⚠️ Could not reach the Bible API. Please try again in a moment.`;

      return await interaction.editReply(msg);
    }
  }

  // ── /ver ─────────────────────────────────────
  if (commandName === 'ver') {
    const input = interaction.options.getString('text').trim();

    await interaction.deferReply();

    if (!bibleFlat.length) {
      return await interaction.editReply('⚠️ Local Bible data is unavailable. Please contact the bot owner.');
    }

    const match = searchVerse(input);

    if (!match) {
      return await interaction.editReply(
        `❌ No verse found for **"${input}"**.\n💡 Try different or simpler keywords.`
      );
    }

    const ref   = `${match.book} ${match.chapter}:${match.verse}`;
    const embed = verseEmbed(ref, match.text, 0x10b981)
      .setFooter({ text: `King James Version  •  Matched ${match.score} keyword(s)` });

    return await interaction.editReply({ embeds: [embed] });
  }
});

// ──────────────────────────────────────────────
//  EXPRESS HEALTH-CHECK SERVER
// ──────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.json({ status: 'ok', bot: client.user?.tag ?? 'starting' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', verses: bibleFlat.length }));

const server = app.listen(PORT, () =>
  console.log(`🌐 Health server → http://localhost:${PORT}`)
);

// ──────────────────────────────────────────────
//  GRACEFUL SHUTDOWN (critical for Render / Railway)
// ──────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n⚠️  ${signal} received — shutting down gracefully`);
  client.destroy();
  server.close(() => {
    console.log('✅ Shutdown complete');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000); // force-exit safety net
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Catch unhandled promise rejections (prevents silent crashes)
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

// ──────────────────────────────────────────────
//  LOGIN
// ──────────────────────────────────────────────
client.login(process.env.TOKEN)
  .then(() => console.log('✅ Discord login successful'))
  .catch(err => {
    console.error('❌ Discord login failed:', err.message);
    process.exit(1);
  });