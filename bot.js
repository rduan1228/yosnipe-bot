const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { Pool } = require('pg');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

// Initialize PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Create tables if they don't exist
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS snipes (
        id SERIAL PRIMARY KEY,
        sniper_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

// Database helper functions
async function recordSnipe(sniperId, targetId) {
  const result = await pool.query(
    'INSERT INTO snipes (sniper_id, target_id) VALUES ($1, $2) RETURNING id',
    [sniperId, targetId]
  );
  return result.rows[0].id;
}

async function removeLastSnipe(sniperId) {
  const result = await pool.query(
    'DELETE FROM snipes WHERE id = (SELECT id FROM snipes WHERE sniper_id = $1 ORDER BY timestamp DESC LIMIT 1) RETURNING target_id',
    [sniperId]
  );
  return result.rows[0];
}

async function getUserStats(userId) {
  const result = await pool.query(
    `SELECT 
      (SELECT COUNT(*) FROM snipes WHERE sniper_id = $1) as total_snipes,
      (SELECT COUNT(*) FROM snipes WHERE target_id = $1) as times_sniped
    `,
    [userId]
  );
  return result.rows[0];
}

async function getTopSnipers(limit = 10) {
  const result = await pool.query(
    `SELECT sniper_id, COUNT(*) as count 
     FROM snipes 
     GROUP BY sniper_id 
     ORDER BY count DESC 
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getTopVictims(limit = 10) {
  const result = await pool.query(
    `SELECT target_id, COUNT(*) as count 
     FROM snipes 
     GROUP BY target_id 
     ORDER BY count DESC 
     LIMIT $1`,
    [limit]
  );
  return result.rows;
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
    .setName('help')
    .setDescription('Show bot commands and usage'),
].map(command => command.toJSON());

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Initialize database
  await initDatabase();
  
  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    console.log('Started refreshing application (/) commands.');
    
    // Register commands to your guild
    // await rest.put(
    //   Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
    //   { body: commands },
    // );
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
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // /snipe command
  if (commandName === 'snipe') {
    const target = interaction.options.getUser('target');
    
    if (target.id === interaction.user.id) {
      return interaction.reply({ 
        content: 'You can\'t snipe yourself! 😅', 
        ephemeral: true 
      });
    }

    if (target.bot) {
      return interaction.reply({ 
        content: 'You can\'t snipe bots! 🤖', 
        ephemeral: true 
      });
    }

    try {
      await recordSnipe(interaction.user.id, target.id);
      const stats = await getUserStats(interaction.user.id);
      
      // Send ephemeral confirmation to the sniper
      await interaction.reply({ 
        content: `🎯 Successfully sniped ${target.username}! Total snipes: ${stats.total_snipes}`, 
        ephemeral: true 
      });

      // Try to DM the victim
      try {
        await target.send(`You just got sniped by ${interaction.user.username}! 💥`);
      } catch (dmError) {
        // If DM fails (user has DMs disabled), silently fail
        console.log(`Could not DM ${target.username}`);
      }
    } catch (error) {
      console.error('Error recording snipe:', error);
      await interaction.reply({ 
        content: 'Error recording snipe. Please try again.', 
        ephemeral: true 
      });
    }
  }

  // /unsnipe command
  if (commandName === 'unsnipe') {
    try {
      const removed = await removeLastSnipe(interaction.user.id);
      
      if (!removed) {
        return interaction.reply({ 
          content: 'You have no snipes to remove!', 
          ephemeral: true 
        });
      }

      const victim = await client.users.fetch(removed.target_id);
      await interaction.reply({ 
        content: `✅ Removed your last snipe against ${victim.username}`, 
        ephemeral: true 
      });
    } catch (error) {
      console.error('Error removing snipe:', error);
      await interaction.reply({ 
        content: 'Error removing snipe. Please try again.', 
        ephemeral: true 
      });
    }
  }

  // /snipestats command
  if (commandName === 'snipestats') {
    const target = interaction.options.getUser('user') || interaction.user;

    try {
      const stats = await getUserStats(target.id);

      if (parseInt(stats.total_snipes) === 0 && parseInt(stats.times_sniped) === 0) {
        return interaction.reply({ 
          content: `${target.username} has no snipe activity yet!`, 
          ephemeral: true 
        });
      }

      const kd = parseInt(stats.times_sniped) > 0 
        ? (parseInt(stats.total_snipes) / parseInt(stats.times_sniped)).toFixed(2) 
        : stats.total_snipes;

      const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle(`📊 Snipe Stats for ${target.username}`)
        .addFields(
          { name: '🎯 Total Snipes', value: `${stats.total_snipes}`, inline: true },
          { name: '💀 Times Sniped', value: `${stats.times_sniped}`, inline: true },
          { name: '📈 K/D Ratio', value: `${kd}`, inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
      console.error('Error fetching stats:', error);
      await interaction.reply({ 
        content: 'Error fetching stats. Please try again.', 
        ephemeral: true 
      });
    }
  }

  // /leaderboard command
  if (commandName === 'leaderboard') {
    const type = interaction.options.getString('type') || 'snipers';

    try {
      if (type === 'snipers') {
        const leaderboard = await getTopSnipers(10);

        const embed = new EmbedBuilder()
          .setColor('#4CAF50')
          .setTitle('🏆 TOP SNIPERS LEADERBOARD')
          .setDescription(leaderboard.length === 0 ? 'No snipes recorded yet!' : 
            leaderboard.map((entry, i) => {
              const user = client.users.cache.get(entry.sniper_id);
              const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
              return `${medal} **${user?.username || 'Unknown'}** - ${entry.count} snipes`;
            }).join('\n'))
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: false });
      } else if (type === 'victims') {
        const leaderboard = await getTopVictims(10);

        const embed = new EmbedBuilder()
          .setColor('#F44336')
          .setTitle('💀 MOST SNIPED VICTIMS')
          .setDescription(leaderboard.length === 0 ? 'No snipes recorded yet!' : 
            leaderboard.map((entry, i) => {
              const user = client.users.cache.get(entry.target_id);
              const medal = i === 0 ? '💀' : i === 1 ? '☠️' : i === 2 ? '👻' : `${i + 1}.`;
              return `${medal} **${user?.username || 'Unknown'}** - ${entry.count} times sniped`;
            }).join('\n'))
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: false });
      }
    } catch (error) {
      console.error('Error fetching leaderboard:', error);
      await interaction.reply({ 
        content: 'Error fetching leaderboard. Please try again.', 
        ephemeral: true 
      });
    }
  }

  // /help command
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
        { name: '/help', value: 'Show this help message' }
      )
      .setFooter({ text: 'Data is permanently stored in PostgreSQL database!' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing database connection');
  await pool.end();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);