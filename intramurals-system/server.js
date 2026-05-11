const express = require('express');
const Redis = require('ioredis');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();

// --- SETUP MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'intramurals-super-secret-key', resave: false, saveUninitialized: false }));

// --- REDIS CONNECTION ---
const redis = new Redis({
  host: 'redis-14178.crce272.asia-seast1-1.gcp.cloud.redislabs.com', // e.g., redis-12345.c250...
  port: 14178,                  // e.g., 12345
  password: 'IEtMGortH2OriEbfriSGMUvY6RiNF3Nw'
});

redis.on('connect', async () => {
    console.log('🏆 Connected to Redis Cloud!');
    if (!(await redis.exists('user:admin'))) {
        const hashedPw = await bcrypt.hash('admin123', 10);
        await redis.hset('user:admin', 'password', hashedPw, 'role', 'manager');
    }
});

// --- AUTH MIDDLEWARE ---
const requireLogin = (req, res, next) => req.session.username ? next() : res.redirect('/login');
const requireManager = (req, res, next) => req.session.role === 'manager' ? next() : res.status(403).send("Managers Only.");

// --- AUTH ROUTES ---
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/register', async (req, res) => {
    if (await redis.exists(`user:${req.body.username}`)) return res.render('login', { error: 'Username taken' });
    const hashedPw = await bcrypt.hash(req.body.password, 10);
    await redis.hset(`user:${req.body.username}`, 'password', hashedPw, 'role', 'student');
    res.render('login', { error: 'Registration successful! Please log in.' });
});
app.post('/login', async (req, res) => {
    const userData = await redis.hgetall(`user:${req.body.username}`);
    if (userData.password && await bcrypt.compare(req.body.password, userData.password)) {
        req.session.username = req.body.username;
        req.session.role = userData.role;
        return res.redirect(userData.role === 'manager' ? '/manager/dashboard' : '/student/dashboard');
    }
    res.render('login', { error: 'Invalid credentials' });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/', (req, res) => res.redirect('/login'));

// --- STUDENT ROUTES ---
app.get('/student/dashboard', requireLogin, async (req, res) => {
    const leaderboardData = await redis.zrevrange('leaderboard:futsal', 0, -1, 'WITHSCORES');
    const leaderboard = [];
    let myTeam = null; // Find if student is a captain

    for (let i = 0; i < leaderboardData.length; i += 2) {
        const teamData = await redis.hgetall(`team:${leaderboardData[i]}`);
        leaderboard.push({ id: leaderboardData[i], ...teamData, score: leaderboardData[i+1] });
        if (teamData.captain === req.session.username) myTeam = { id: leaderboardData[i], ...teamData };
    }

    const loanKeys = await redis.keys('loan:*');
    const myLoans = [];
    for (let key of loanKeys) {
        const data = await redis.hgetall(key);
        if (data.borrower === req.session.username) myLoans.push(data);
    }
    res.render('student', { username: req.session.username, leaderboard, myLoans, myTeam });
});

app.post('/student/apply-team', requireLogin, async (req, res) => {
    if (await redis.exists(`team:${req.body.teamId}`)) return res.redirect('/student/dashboard?error=Team ID taken!');
    await redis.hset(`team:${req.body.teamId}`, 'name', req.body.name, 'captain', req.session.username, 'players', req.body.players, 'status', 'Pending');
    await redis.zadd('leaderboard:futsal', 0, req.body.teamId);
    res.redirect('/student/dashboard?success=Team application submitted!');
});

// NEW: Student Edit Team
app.post('/student/edit-team', requireLogin, async (req, res) => {
    const { teamId, name, players } = req.body;
    await redis.hset(`team:${teamId}`, 'name', name, 'players', players);
    res.redirect('/student/dashboard?success=Team updated successfully!');
});

// --- MANAGER ROUTES ---
app.get('/manager/dashboard', requireLogin, requireManager, async (req, res) => {
    // Calculate Stats
    const teamKeys = await redis.keys('team:*');
    let pendingApps = 0;
    for (let k of teamKeys) { if (await redis.hget(k, 'status') === 'Pending') pendingApps++; }
    
    const activeLoansCount = (await redis.keys('loan:*')).length;
    const stats = { totalTeams: teamKeys.length, pendingApps, activeLoansCount };

    const leaderboardData = await redis.zrevrange('leaderboard:futsal', 0, -1, 'WITHSCORES');
    const leaderboard = [];
    for (let i = 0; i < leaderboardData.length; i += 2) {
        const teamName = await redis.hget(`team:${leaderboardData[i]}`, 'name');
        leaderboard.push({ id: leaderboardData[i], name: teamName, score: leaderboardData[i+1] });
    }
    const equipment = {
        futsalBalls: await redis.hget('equipment:futsal_balls', 'available') || 10,
        bibs: await redis.hget('equipment:bibs', 'available') || 20
    };

    res.render('dashboard', { leaderboard, equipment, stats });
});

app.get('/teams', requireLogin, requireManager, async (req, res) => {
    let teams = [];
    const keys = req.query.search ? [`team:${req.query.search}`] : await redis.keys('team:*');
    for (let key of keys) {
        const teamData = await redis.hgetall(key);
        if (teamData.name) teams.push({ id: key.split(':')[1], ...teamData });
    }
    res.render('teams', { teams });
});

app.post('/teams/status', requireLogin, requireManager, async (req, res) => {
    await redis.hset(`team:${req.body.teamId}`, 'status', req.body.status);
    res.redirect('/teams?success=Status updated');
});

app.post('/teams/add', requireLogin, requireManager, async (req, res) => {
    if (await redis.exists(`team:${req.body.teamId}`)) return res.redirect('/teams?error=Team ID exists!');
    await redis.hset(`team:${req.body.teamId}`, 'name', req.body.name, 'captain', req.body.captain, 'players', req.body.players, 'status', 'Cleared');
    await redis.zadd('leaderboard:futsal', 0, req.body.teamId);
    res.redirect('/teams?success=Team added');
});

app.post('/teams/score', requireLogin, requireManager, async (req, res) => {
    await redis.zincrby('leaderboard:futsal', req.body.points, req.body.teamId);
    res.redirect('/manager/dashboard?success=Score updated');
});

app.post('/teams/delete', requireLogin, requireManager, async (req, res) => {
    await redis.del(`team:${req.body.teamId}`);
    await redis.zrem('leaderboard:futsal', req.body.teamId);
    res.redirect('/teams?success=Team deleted');
});

// EQUIPMENT & HISTORY
app.get('/equipment', requireLogin, requireManager, async (req, res) => {
    const loans = [];
    for (let key of await redis.keys('loan:*')) loans.push({ id: key, ...(await redis.hgetall(key)) });
    const students = [];
    for (let key of await redis.keys('user:*')) {
        if (await redis.hget(key, 'role') === 'student') students.push(key.split(':')[1]);
    }
    res.render('equipment', { loans, students });
});

app.post('/equipment/borrow', requireLogin, requireManager, async (req, res) => {
    const { borrower, item, quantity } = req.body;
    await redis.hset(`loan:${Date.now()}`, { borrower, item, quantity, date: new Date().toLocaleString() });
    await redis.hincrby(`equipment:${item}`, 'available', -quantity);
    res.redirect('/equipment?success=Gear checked out');
});

// NEW: Archived History Logic
app.post('/equipment/return', requireLogin, requireManager, async (req, res) => {
    const loanData = await redis.hgetall(req.body.loanId);
    loanData.returnDate = new Date().toLocaleString(); // Add return timestamp
    await redis.lpush('history:loans', JSON.stringify(loanData)); // Save to history list

    await redis.del(req.body.loanId);
    await redis.hincrby(`equipment:${req.body.item}`, 'available', req.body.quantity);
    res.redirect('/equipment?success=Gear returned and archived');
});

// NEW: History View
app.get('/equipment/history', requireLogin, requireManager, async (req, res) => {
    const historyData = await redis.lrange('history:loans', 0, -1);
    const history = historyData.map(data => JSON.parse(data));
    res.render('history', { history });
});

app.get('/backup', requireLogin, requireManager, async (req, res) => {
    const backupData = {};
    for (let key of await redis.keys('*')) {
        const type = await redis.type(key);
        if (type === 'hash') backupData[key] = await redis.hgetall(key);
        if (type === 'zset') backupData[key] = await redis.zrange(key, 0, -1, 'WITHSCORES');
        if (type === 'list') backupData[key] = await redis.lrange(key, 0, -1);
    }
    res.setHeader('Content-disposition', 'attachment; filename=database_backup.json');
    res.send(JSON.stringify(backupData, null, 2));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));