const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { Pool } = require('pg');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// Initialize PostgreSQL connection with Railway-friendly settings
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 3,                      // keep pool small on free tier
  idleTimeoutMillis: 10000,    // kill idle connections after 10s (before Railway kills them)
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true,
});

// Handle unexpected pool errors so they don't crash the bot
pool.on('error', (err) => {
  console.error('Unexpected pool error:', err.message);
});

// Season cutoff for the leaderboard - only snipes on/after this date count
const LEADERBOARD_SEASON_START = '2026-08-24T00:00:00Z';

// Retry wrapper for all DB calls
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`DB error (${err.code}), retrying (${i + 1}/${retries})...`);
      await new Promise(res => setTimeout(res, delay * (i + 1)));
    }
  }
}

// Create tables if they don't exist
async function initDatabase() {
  try {
    await withRetry(() => pool.query(`
      CREATE TABLE IF NOT EXISTS snipes (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        sniper_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `));
    console.log('Database initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

// Database helper functions - ALL WITH GUILD_ID
async function recordSnipe(guildId, sniperId, targetId) {
  const result = await withRetry(() => pool.query(
    'INSERT INTO snipes (guild_id, sniper_id, target_id) VALUES ($1, $2, $3) RETURNING id',
    [guildId, sniperId, targetId]
  ));
  return result.rows[0].id;
}

async function removeLastSnipe(guildId, sniperId) {
  const result = await withRetry(() => pool.query(
    'DELETE FROM snipes WHERE id = (SELECT id FROM snipes WHERE guild_id = $1 AND sniper_id = $2 ORDER BY timestamp DESC LIMIT 1) RETURNING target_id',
    [guildId, sniperId]
  ));
  return result.rows[0];
}

async function getUserStats(guildId, userId) {
  const result = await withRetry(() => pool.query(
    `SELECT 
      (SELECT COUNT(*) FROM snipes WHERE guild_id = $1 AND sniper_id = $2 AND timestamp >= $3) as total_snipes,
      (SELECT COUNT(*) FROM snipes WHERE guild_id = $1 AND target_id = $2 AND timestamp >= $3) as times_sniped
    `,
    [guildId, userId, LEADERBOARD_SEASON_START]
  ));
  return result.rows[0];
}

async function getTopSnipers(guildId, limit = 10) {
  const result = await withRetry(() => pool.query(
    `SELECT sniper_id, COUNT(*) as count 
     FROM snipes 
     WHERE guild_id = $1 AND timestamp >= $2
     GROUP BY sniper_id 
     ORDER BY count DESC 
     LIMIT $3`,
    [guildId, LEADERBOARD_SEASON_START, limit]
  ));
  return result.rows;
}

async function getTopVictims(guildId, limit = 10) {
  const result = await withRetry(() => pool.query(
    `SELECT target_id, COUNT(*) as count 
     FROM snipes 
     WHERE guild_id = $1 AND timestamp >= $2
     GROUP BY target_id 
     ORDER BY count DESC 
     LIMIT $3`,
    [guildId, LEADERBOARD_SEASON_START, limit]
  ));
  return result.rows;
}

async function getUserTopVictims(guildId, sniperId, limit = 3) {
  const result = await withRetry(() => pool.query(
    `SELECT target_id, COUNT(*) as count 
     FROM snipes 
     WHERE guild_id = $1 AND sniper_id = $2 AND timestamp >= $3
     GROUP BY target_id 
     ORDER BY count DESC 
     LIMIT $4`,
    [guildId, sniperId, LEADERBOARD_SEASON_START, limit]
  ));
  return result.rows;
}

async function getSnipesHistory(guildId, offset = 0, limit = 10) {
  const result = await withRetry(() => pool.query(
    `SELECT sniper_id, target_id, timestamp 
     FROM snipes 
     WHERE guild_id = $1 AND timestamp >= $2
     ORDER BY timestamp DESC 
     LIMIT $3 OFFSET $4`,
    [guildId, LEADERBOARD_SEASON_START, limit, offset]
  ));
  return result.rows;
}

async function getTotalSnipesCount(guildId) {
  const result = await withRetry(() => pool.query(
    'SELECT COUNT(*) as count FROM snipes WHERE guild_id = $1 AND timestamp >= $2',
    [guildId, LEADERBOARD_SEASON_START]
  ));
  return parseInt(result.rows[0].count);
}

async function getOps(guildId, userid, limit = 3) {
  const result = await withRetry(() => pool.query(
    `SELECT sniper_id, COUNT(*) as count 
     FROM snipes 
     WHERE guild_id = $1 AND target_id = $2 AND timestamp >= $3
     GROUP BY sniper_id 
     ORDER BY count DESC 
     LIMIT $4`,
    [guildId, userid, LEADERBOARD_SEASON_START, limit]
  ));
  return result.rows;
}

async function getSnipeStreak(guildId, userId) {
  const result = await withRetry(() => pool.query(
    `
    WITH last_death AS (
      SELECT MAX(id) AS last_death_id
      FROM snipes
      WHERE guild_id = $1 AND target_id = $2 AND timestamp >= $3
    )
    SELECT COUNT(*) AS streak
    FROM snipes
    WHERE guild_id = $1 AND sniper_id = $2 AND timestamp >= $3
      AND id > COALESCE((SELECT last_death_id FROM last_death), 0)
    `,
    [guildId, userId, LEADERBOARD_SEASON_START]
  ));

  return Number(result.rows[0].streak);
}

// Helper functions for snipe history
async function createHistoryEmbed(snipes, page, limit, totalSnipes, interaction) {
  const startNum = page * limit + 1;
  const endNum = Math.min((page + 1) * limit, totalSnipes);
  
  const historyLines = await Promise.all(
    snipes.map(async (snipe, index) => {
      try {
        const sniperMember = await interaction.guild.members.fetch(snipe.sniper_id).catch(() => null);
        const targetMember = await interaction.guild.members.fetch(snipe.target_id).catch(() => null);
        
        const sniperName = sniperMember ? sniperMember.displayName : 'Unknown User';
        const targetName = targetMember ? targetMember.displayName : 'Unknown User';
        
        const snipeNumber = startNum + index;
        const time = new Date(snipe.timestamp).toLocaleString();
        
        let streakText = '';
        if (index > 0 && snipes[index - 1].sniper_id === snipe.sniper_id) {
          let streakCount = 2;
          for (let i = index - 2; i >= 0; i--) {
            if (snipes[i].sniper_id === snipe.sniper_id) {
              streakCount++;
            } else {
              break;
            }
          }
          streakText = ` 🔥${streakCount}`;
        }
        
        return `${snipeNumber}. ${time}: **${sniperName}** has sniped **${targetName}**${streakText}`;
      } catch (err) {
        const snipeNumber = startNum + index;
        const time = new Date(snipe.timestamp).toLocaleString();
        return `${snipeNumber}. ${time}: Unknown User has sniped Unknown User`;
      }
    })
  );
  
  const embed = new EmbedBuilder()
    .setColor('#9C27B0')
    .setTitle('📜 Snipe History')
    .setDescription(historyLines.length > 0 ? historyLines.join('\n') : 'No snipes recorded yet!')
    .setFooter({ text: `Page ${page + 1} • Showing ${startNum}-${endNum} of ${totalSnipes} snipes` })
    .setTimestamp();
    
  return embed;
}

function createHistoryButtons(page, limit, totalSnipes) {
  const totalPages = Math.ceil(totalSnipes / limit);
  const hasPrev = page > 0;
  const hasNext = page < totalPages - 1;
  
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`snipehistory_prev_${page}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!hasPrev),
      new ButtonBuilder()
        .setCustomId(`snipehistory_next_${page}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!hasNext)
    );
    
  return [row];
}

// Create the Show Off button as a reusable helper (returns components array)
function createShowoffButton() {
  const showoffButton = new ButtonBuilder()
    .setCustomId('showoff_stats')
    .setLabel('📢 Show Off')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(showoffButton);
  return [row];
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('snipe')
    .setDescription('Log a snipe against a user')
    .addUserOption(option =>
      option.setName('target')
        .setDescription('The user you sniped')
        .setRequired(true)),
  
  new SlashCommandBuilder()
    .setName('unsnipe')
    .setDescription('Remove your last logged snipe'),
  
  new SlashCommandBuilder()
    .setName('snipestats')
    .setDescription('View snipe statistics')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to check stats for (defaults to you)')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View snipe leaderboards')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of leaderboard')
        .setRequired(false)
        .addChoices(
          { name: 'Top Snipers', value: 'snipers' },
          { name: 'Most Sniped Victims', value: 'victims' }
        )),
  
  new SlashCommandBuilder()
    .setName('ops')
    .setDescription('Get who sniped you the most')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to check stats for (defaults to you)')
        .setRequired(false)),
  
  new SlashCommandBuilder()
    .setName('snipehistory')
    .setDescription('View global snipe history (10 per page)'),
  
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show bot commands and usage'),
].map(command => command.toJSON());

// Fixed: renamed 'ready' to 'clientReady' to fix deprecation warning
client.on('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  await initDatabase();
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    console.log('Started refreshing application (/) commands.');
    
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
});

client.on('interactionCreate', async (interaction) => {
  // ─── BUTTON HANDLERS ──────────────────────────────────────────────────────
  if (interaction.isButton()) {
    // Snipe history pagination
    const parts = interaction.customId.split('_');
    if (parts[0] === 'snipehistory') {
      const action = parts[1];
      const currentPage = parseInt(parts[2]);
      
      let newPage = currentPage;
      if (action === 'prev' && currentPage > 0) {
        newPage = currentPage - 1;
      } else if (action === 'next') {
        newPage = currentPage + 1;
      }
      
      try {
        await interaction.deferUpdate();
        
        const totalSnipes = await getTotalSnipesCount(interaction.guildId);
        const limit = 10;
        const snipes = await getSnipesHistory(interaction.guildId, newPage * limit, limit);
        
        const embed = await createHistoryEmbed(snipes, newPage, limit, totalSnipes, interaction);
        const components = createHistoryButtons(newPage, limit, totalSnipes);
        
        await interaction.editReply({ embeds: [embed], components });
      } catch (error) {
        console.error('Error updating snipe history:', error);
        await interaction.editReply({ content: 'Error updating snipe history. Please try again.' });
      }
      return;
    }

    // Show Off button — post the ephemeral stats embed publicly
    if (interaction.customId === 'showoff_stats') {
      try {
        await interaction.deferUpdate();
        // Fetch the original embed from the message and repost it publicly
        const originalEmbed = interaction.message.embeds[0];
        if (originalEmbed) {
          await interaction.channel.send({ embeds: [originalEmbed] });
        }
      } catch (error) {
        console.error('Error showing off stats:', error);
      }
      return;
    }
  }
  
  // ─── SLASH COMMAND HANDLERS ───────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // ── /snipe ──────────────────────────────────────────────────────────────
    if (commandName === 'snipe') {
      if (!interaction.guildId) {
        return interaction.reply({
          content: 'This command can only be used in a server!',
          flags: MessageFlags.Ephemeral,
        });
      }

      const target = interaction.options.getUser('target');
      
      if (target.id === interaction.user.id) {
        return interaction.reply({ 
          content: 'You can\'t snipe yourself! 😅', 
          flags: MessageFlags.Ephemeral,
        });
      }

      if (target.bot) {
        return interaction.reply({ 
          content: 'You can\'t snipe bots! 🤖', 
          flags: MessageFlags.Ephemeral,
        });
      }

      // FIX: defer immediately so Discord doesn't time out while DB calls run
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await recordSnipe(interaction.guildId, interaction.user.id, target.id);
        const stats = await getUserStats(interaction.guildId, interaction.user.id);
        const streak = await getSnipeStreak(interaction.guildId, interaction.user.id);
        
        await interaction.editReply({ 
          content: `🎯 Snipe recorded! Total snipes: ${stats.total_snipes}`,
        });

        await interaction.channel.send(`🎯 ${interaction.user} just sniped ${target}! 💥`);
        
        if (streak >= 2) {
          await interaction.channel.send(
            `🔥 ${interaction.user} is on a **${streak}-snipe streak!**`
          );
        }
      } catch (error) {
        console.error('Error recording snipe:', error);
        await interaction.editReply({ 
          content: 'Error recording snipe. Please try again.',
        });
      }
      return;
    }

    // ── /unsnipe ─────────────────────────────────────────────────────────────
    if (commandName === 'unsnipe') {
      // Defer immediately — DB call may be slow on cold start
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const removed = await removeLastSnipe(interaction.guildId, interaction.user.id);
        
        if (!removed) {
          return interaction.editReply({ content: 'You have no snipes to remove!' });
        }

        const victim = await client.users.fetch(removed.target_id);
        await interaction.editReply({ 
          content: `✅ Removed your last snipe against ${victim.username}`,
        });
      } catch (error) {
        console.error('Error removing snipe:', error);
        await interaction.editReply({ 
          content: 'Error removing snipe. Please try again.',
        });
      }
      return;
    }

    // ── /snipestats ──────────────────────────────────────────────────────────
    if (commandName === 'snipestats') {
      const target = interaction.options.getUser('user') || interaction.user;

      // Defer immediately — multiple DB calls ahead
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const stats = await getUserStats(interaction.guildId, target.id);

        if (parseInt(stats.total_snipes) === 0 && parseInt(stats.times_sniped) === 0) {
          return interaction.editReply({
            content: `${target.username} has no snipe activity yet!`,
          });
        }

        const streak = await getSnipeStreak(interaction.guildId, target.id);
        const topVictimsResult = await getUserTopVictims(interaction.guildId, target.id, 3);
        const topVictims = await Promise.all(topVictimsResult.map(async (entry) => {
          try {
            const member = await interaction.guild.members.fetch(entry.target_id);
            return `**${member.displayName}** (${entry.count})`;
          } catch {
            return `**Unknown** (${entry.count})`;
          }
        }));

        const topOpsResult = await getOps(interaction.guildId, target.id, 3);
        const topOps = await Promise.all(topOpsResult.map(async (entry) => {
          try {
            const member = await interaction.guild.members.fetch(entry.sniper_id);
            return `**${member.displayName}** (${entry.count})`;
          } catch {
            return `**Unknown** (${entry.count})`;
          }
        }));

        const kd = parseInt(stats.times_sniped) > 0
          ? (parseInt(stats.total_snipes) / parseInt(stats.times_sniped)).toFixed(2)
          : (parseInt(stats.total_snipes) > 0 ? '∞' : '0');

        const embed = new EmbedBuilder()
          .setColor('#FF6B6B')
          .setTitle(`📊 Snipe Stats for ${target.username}`)
          .addFields(
            { name: '🎯 Total Snipes', value: `${stats.total_snipes}`, inline: true },
            { name: '💀 Times Sniped', value: `${stats.times_sniped}`, inline: true },
            { name: '📈 K/D Ratio', value: `${kd}`, inline: true },
            { name: '🔥 Current Streak', value: `${streak}`, inline: true },
            {
              name: '🔝 Top Victims',
              value: topVictims.length > 0
                ? topVictims.slice(0, 3).map((v, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
                    return `${medal} ${v}`;
                  }).join('\n')
                : 'None',
              inline: true
            },
            {
              name: '🔎 Top Ops',
              value: topOps.length > 0
                ? topOps.slice(0, 3).map((v, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
                    return `${medal} ${v}`;
                  }).join('\n')
                : 'None',
              inline: true
            }
          )
          .setTimestamp();

        const components = createShowoffButton();

        // FIX: use editReply after deferReply (flags already set on defer)
        await interaction.editReply({ embeds: [embed], components });

        // FIX: removed the old collector approach — the showoff button is now
        // handled globally in the isButton() block above, so it works permanently
        // (not just for 60s) and doesn't require fetchReply.
      } catch (error) {
        console.error('Error fetching stats:', error);
        await interaction.editReply({
          content: 'Error fetching stats. Please try again.',
        });
      }
      return;
    }

    // ── /leaderboard ─────────────────────────────────────────────────────────
    if (commandName === 'leaderboard') {
      const type = interaction.options.getString('type') || 'snipers';

      try {
        await interaction.deferReply({ ephemeral: false });

        if (type === 'snipers') {
          const leaderboard = await getTopSnipers(interaction.guildId, 10);

          const leaderboardWithUsers = await Promise.all(
            leaderboard.map(async (entry, i) => {
              try {
                const member = await interaction.guild.members.fetch(entry.sniper_id);
                const displayName = member.displayName;
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                return `${medal} **${displayName}** - ${entry.count} snipes`;
              } catch (err) {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                return `${medal} **Unknown User** - ${entry.count} snipes`;
              }
            })
          );

          const embed = new EmbedBuilder()
            .setColor('#4CAF50')
            .setTitle('🏆 2026-27 TOP SNIPERS LEADERBOARD')
            .setDescription(leaderboard.length === 0 ? 'No snipes recorded yet!' : 
              leaderboardWithUsers.join('\n'))
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } else if (type === 'victims') {
          const leaderboard = await getTopVictims(interaction.guildId, 10);

          const leaderboardWithUsers = await Promise.all(
            leaderboard.map(async (entry, i) => {
              try {
                const member = await interaction.guild.members.fetch(entry.target_id);
                const displayName = member.displayName;
                const medal = i === 0 ? '💀' : i === 1 ? '☠️' : i === 2 ? '👻' : `${i + 1}.`;
                return `${medal} **${displayName}** - ${entry.count} times sniped`;
              } catch (err) {
                const medal = i === 0 ? '💀' : i === 1 ? '☠️' : i === 2 ? '👻' : `${i + 1}.`;
                return `${medal} **Unknown User** - ${entry.count} times sniped`;
              }
            })
          );

          const embed = new EmbedBuilder()
            .setColor('#F44336')
            .setTitle('💀 MOST SNIPED VICTIMS')
            .setDescription(leaderboard.length === 0 ? 'No snipes recorded yet!' : 
              leaderboardWithUsers.join('\n'))
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        }
      } catch (error) {
        console.error('Error fetching leaderboard:', error);
        await interaction.editReply({ 
          content: 'Error fetching leaderboard. Please try again.'
        });
      }
      return;
    }

    // ── /ops ─────────────────────────────────────────────────────────────────
    if (commandName === 'ops') {
      const target = interaction.options.getUser('user') || interaction.user;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const opponents = await getOps(interaction.guildId, target.id, 3);
        
        if (!opponents || opponents.length === 0) { 
          return interaction.editReply({ 
            content: `${target.username} has not been sniped!`,
          });
        }

        const embed = new EmbedBuilder()
          .setColor('#d56bffff')
          .setTitle(`🔎 Top Ops for ${target.username}`)
          .setDescription(
              opponents.map((entry, i) => {
                const user = client.users.cache.get(entry.sniper_id);
                const medal = i === 0 ? '1️⃣' : i === 1 ? '2️⃣' : i === 2 ? '3️⃣' : `${i + 1}.`;
                return `${medal} **${user?.username || 'Unknown'}** - ${entry.count} snipes`;
              }).join('\n'))
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('Error fetching ops:', error);
        await interaction.editReply({ 
          content: 'Error fetching ops. Please try again.',
        });
      }
      return;
    }

    // ── /help ─────────────────────────────────────────────────────────────────
    if (commandName === 'help') {
      const embed = new EmbedBuilder()
        .setColor('#2196F3')
        .setTitle('🎯 Snipe Bot Commands')
        .setDescription('Track your snipes and dominate the leaderboard!')
        .addFields(
          { name: '/snipe @user', value: 'Log a snipe against the mentioned user' },
          { name: '/unsnipe', value: 'Remove your last logged snipe (in case of typo)' },
          { name: '/snipestats [@user]', value: 'View snipe statistics for yourself or another user' },
          { name: '/leaderboard [type]', value: 'View top snipers or most sniped victims (public)' },
          { name: '/ops [@user]', value: 'View who sniped you the most' },
          { name: '/snipehistory', value: 'View snipe history with pagination' },
          { name: '/help', value: 'Show this help message' }
        )
        .setFooter({ text: 'Data is permanently stored in PostgreSQL database!' });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    // ── /snipehistory ─────────────────────────────────────────────────────────
    if (commandName === 'snipehistory') {
      try {
        await interaction.deferReply({ ephemeral: false });
        
        const totalSnipes = await getTotalSnipesCount(interaction.guildId);
        if (totalSnipes === 0) {
          return interaction.editReply({ content: 'No snipes recorded yet!' });
        }

        const page = 0;
        const limit = 10;
        const snipes = await getSnipesHistory(interaction.guildId, page * limit, limit);
        
        const embed = await createHistoryEmbed(snipes, page, limit, totalSnipes, interaction);
        const components = createHistoryButtons(page, limit, totalSnipes);
        
        await interaction.editReply({ embeds: [embed], components });
      } catch (error) {
        console.error('Error fetching snipe history:', error);
        await interaction.editReply({ content: 'Error fetching snipe history. Please try again.' });
      }
      return;
    }
  }
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing database connection');
  await pool.end();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);