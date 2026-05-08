const express = require('express');
const Redis = require('ioredis');
const app = express();

// --- 1. SETUP MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true })); // Parses form data

// --- 2. REDIS CLOUD CONNECTION ---
const redis = new Redis({
  host: 'redis-14178.crce272.asia-seast1-1.gcp.cloud.redislabs.com', // e.g., redis-12345.c250...
  port: 14178,                  // e.g., 12345
  password: 'IEtMGortH2OriEbfriSGMUvY6RiNF3Nw'
});

redis.on('connect', () => console.log('🏆 Connected to Redis Cloud!'));

// --- 3. ROUTES (Hitting the CRUD Requirements) ---

// READ: Main Dashboard (Visuals & Leaderboard)
app.get('/', async (req, res) => {
    // Fetch Sorted Set (Leaderboard) from highest to lowest score
    const leaderboard = await redis.zrevrange('leaderboard:futsal', 0, -1, 'WITHSCORES');
    
    // Format leaderboard for the frontend
    const formattedBoard = [];
    for (let i = 0; i < leaderboard.length; i += 2) {
        const teamName = await redis.hget(`team:${leaderboard[i]}`, 'name');
        formattedBoard.push({ id: leaderboard[i], name: teamName, score: leaderboard[i+1] });
    }

    // Fetch Equipment for the pie chart
    const futsalBalls = await redis.hget('equipment:futsal_balls', 'available') || 10;
    const bibs = await redis.hget('equipment:bibs', 'available') || 20;

    res.render('dashboard', { leaderboard: formattedBoard, equipment: { futsalBalls, bibs } });
});

// READ & SEARCH: Teams Page
app.get('/teams', async (req, res) => {
    const searchQuery = req.query.search;
    let teams = [];

    if (searchQuery) {
        // SEARCH FUNCTIONALITY: Find specific team by ID
        const teamData = await redis.hgetall(`team:${searchQuery}`);
        if (teamData.name) teams.push({ id: searchQuery, ...teamData });
    } else {
        // Fetch all teams
        const keys = await redis.keys('team:*');
        for (let key of keys) {
            const teamData = await redis.hgetall(key);
            teams.push({ id: key.split(':')[1], ...teamData });
        }
    }
    res.render('teams', { teams });
});

// CREATE: Register a new team
app.post('/teams/add', async (req, res) => {
    const { teamId, name, captain } = req.body;
    // Save to Hash
    await redis.hset(`team:${teamId}`, 'name', name, 'captain', captain, 'status', 'Cleared');
    // Add to Leaderboard with 0 points
    await redis.zadd('leaderboard:futsal', 0, teamId);
    res.redirect('/teams');
});

// UPDATE: Add points to a team
app.post('/teams/score', async (req, res) => {
    const { teamId, points } = req.body;
    // Increment score in the Sorted Set
    await redis.zincrby('leaderboard:futsal', points, teamId);
    res.redirect('/');
});

// DELETE: Remove a team
app.post('/teams/delete', async (req, res) => {
    const { teamId } = req.body;
    await redis.del(`team:${teamId}`);
    await redis.zrem('leaderboard:futsal', teamId);
    res.redirect('/teams');
});

// --- EQUIPMENT ROUTES ---

// READ: Equipment Page & Search
app.get('/equipment', async (req, res) => {
    const searchQuery = req.query.search ? req.query.search.toLowerCase() : null;
    const loanKeys = await redis.keys('loan:*');
    let loans = [];

    for (let key of loanKeys) {
        const data = await redis.hgetall(key);
        const loan = { id: key, ...data };
        
        // Simple search filter
        if (!searchQuery || loan.borrower.toLowerCase().includes(searchQuery)) {
            loans.push(loan);
        }
    }
    res.render('equipment', { loans });
});

// CREATE: Borrow Equipment
app.post('/equipment/borrow', async (req, res) => {
    const { borrower, item, quantity } = req.body;
    const loanId = `loan:${Date.now()}`; // Unique ID based on timestamp

    // 1. Create the loan record (CRUD: Create)
    await redis.hset(loanId, {
        borrower,
        item,
        quantity,
        date: new Date().toLocaleString()
    });

    // 2. Update Inventory (CRUD: Update)
    // We use hincrby with a negative number to subtract from stock
    await redis.hincrby(`equipment:${item}`, 'available', -quantity);

    res.redirect('/equipment');
});

// DELETE/UPDATE: Return Equipment
app.post('/equipment/return', async (req, res) => {
    const { loanId, item, quantity } = req.body;

    // 1. Remove the loan record (CRUD: Delete)
    await redis.del(loanId);

    // 2. Put the items back in inventory (CRUD: Update)
    await redis.hincrby(`equipment:${item}`, 'available', quantity);

    res.redirect('/equipment');
});

// --- 4. BACKUP REQUIREMENT (JSON File Download) ---
app.get('/backup', async (req, res) => {
    const keys = await redis.keys('*');
    const backupData = {};
    
    for (let key of keys) {
        const type = await redis.type(key);
        if (type === 'hash') backupData[key] = await redis.hgetall(key);
        if (type === 'zset') backupData[key] = await redis.zrange(key, 0, -1, 'WITHSCORES');
    }

    // Trigger file download in browser
    res.setHeader('Content-disposition', 'attachment; filename=database_backup.json');
    res.setHeader('Content-type', 'application/json');
    res.send(JSON.stringify(backupData, null, 2));
});

// --- START SERVER ---
app.listen(3000, () => console.log('Server running on http://localhost:3000'));