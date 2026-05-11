const express = require('express');
const Redis = require('ioredis');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();

// --- 1. SETUP MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

// Session Management
app.use(session({
    secret: 'intramurals-super-secret-key',
    resave: false,
    saveUninitialized: false
}));

// --- 2. REDIS CLOUD CONNECTION ---
const redis = new Redis({
  host: 'redis-14178.crce272.asia-seast1-1.gcp.cloud.redislabs.com', // e.g., redis-12345.c250...
  port: 14178,                  // e.g., 12345
  password: 'IEtMGortH2OriEbfriSGMUvY6RiNF3Nw'
});

redis.on('connect', async () => {
    console.log('🏆 Connected to Redis Cloud!');
    
    // Auto-create default manager account if it doesn't exist
    const adminExists = await redis.exists('user:admin');
    if (!adminExists) {
        const hashedPw = await bcrypt.hash('admin123', 10);
        await redis.hset('user:admin', 'password', hashedPw, 'role', 'manager');
        console.log('Manager account created: admin / admin123');
    }
});

// --- 3. AUTHENTICATION MIDDLEWARE ---
const requireLogin = (req, res, next) => {
    if (!req.session.username) return res.redirect('/login');
    next();
};

const requireManager = (req, res, next) => {
    if (req.session.role !== 'manager') return res.status(403).send("Access Denied: Managers Only.");
    next();
};

// --- 4. AUTHENTICATION ROUTES ---
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const exists = await redis.exists(`user:${username}`);
    if (exists) return res.render('login', { error: 'Username already taken' });

    const hashedPw = await bcrypt.hash(password, 10);
    await redis.hset(`user:${username}`, 'password', hashedPw, 'role', 'student');
    res.render('login', { error: 'Registration successful! Please log in.' });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const userData = await redis.hgetall(`user:${username}`);
    
    if (userData.password && await bcrypt.compare(password, userData.password)) {
        req.session.username = username;
        req.session.role = userData.role;
        
        if (userData.role === 'manager') return res.redirect('/manager/dashboard');
        return res.redirect('/student/dashboard');
    }
    res.render('login', { error: 'Invalid username or password' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Redirect root to login
app.get('/', (req, res) => res.redirect('/login'));


// --- 5. STUDENT ROUTES ---
app.get('/student/dashboard', requireLogin, async (req, res) => {
    // 1. Get Leaderboard
    const leaderboardData = await redis.zrevrange('leaderboard:futsal', 0, -1, 'WITHSCORES');
    const leaderboard = [];
    for (let i = 0; i < leaderboardData.length; i += 2) {
        const teamName = await redis.hget(`team:${leaderboardData[i]}`, 'name');
        leaderboard.push({ name: teamName, score: leaderboardData[i+1] });
    }

    // 2. Get Student's specific equipment loans
    const loanKeys = await redis.keys('loan:*');
    const myLoans = [];
    for (let key of loanKeys) {
        const data = await redis.hgetall(key);
        // Only show loans assigned to this specific logged-in student
        if (data.borrower === req.session.username) {
            myLoans.push(data);
        }
    }

    res.render('student', { username: req.session.username, leaderboard, myLoans });
});

app.post('/student/apply-team', requireLogin, async (req, res) => {
    const { teamId, name, players } = req.body;
    await redis.hset(`team:${teamId}`, 'name', name, 'captain', req.session.username, 'players', players, 'status', 'Pending');
    await redis.zadd('leaderboard:futsal', 0, teamId);
    res.redirect('/student/dashboard');
});


// --- 6. MANAGER ROUTES (Protected) ---
app.get('/manager/dashboard', requireLogin, requireManager, async (req, res) => {
    const leaderboardData = await redis.zrevrange('leaderboard:futsal', 0, -1, 'WITHSCORES');
    const leaderboard = [];
    for (let i = 0; i < leaderboardData.length; i += 2) {
        const teamName = await redis.hget(`team:${leaderboardData[i]}`, 'name');
        leaderboard.push({ id: leaderboardData[i], name: teamName, score: leaderboardData[i+1] });
    }
    const futsalBalls = await redis.hget('equipment:futsal_balls', 'available') || 10;
    const bibs = await redis.hget('equipment:bibs', 'available') || 20;

    res.render('dashboard', { leaderboard, equipment: { futsalBalls, bibs } });
});

app.get('/teams', requireLogin, requireManager, async (req, res) => {
    const searchQuery = req.query.search;
    let teams = [];
    const keys = searchQuery ? [`team:${searchQuery}`] : await redis.keys('team:*');
    
    for (let key of keys) {
        const teamData = await redis.hgetall(key);
        if (teamData.name) teams.push({ id: key.split(':')[1], ...teamData });
    }
    res.render('teams', { teams });
});

app.post('/teams/score', requireLogin, requireManager, async (req, res) => {
    await redis.zincrby('leaderboard:futsal', req.body.points, req.body.teamId);
    res.redirect('/manager/dashboard');
});

app.post('/teams/delete', requireLogin, requireManager, async (req, res) => {
    await redis.del(`team:${req.body.teamId}`);
    await redis.zrem('leaderboard:futsal', req.body.teamId);
    res.redirect('/teams');
});

app.get('/equipment', requireLogin, requireManager, async (req, res) => {
    const loanKeys = await redis.keys('loan:*');
    let loans = [];
    for (let key of loanKeys) {
        const data = await redis.hgetall(key);
        loans.push({ id: key, ...data });
    }
    res.render('equipment', { loans });
});

app.post('/equipment/borrow', requireLogin, requireManager, async (req, res) => {
    const { borrower, item, quantity } = req.body;
    const loanId = `loan:${Date.now()}`;
    await redis.hset(loanId, { borrower, item, quantity, date: new Date().toLocaleString() });
    await redis.hincrby(`equipment:${item}`, 'available', -quantity);
    res.redirect('/equipment');
});

app.post('/equipment/return', requireLogin, requireManager, async (req, res) => {
    await redis.del(req.body.loanId);
    await redis.hincrby(`equipment:${req.body.item}`, 'available', req.body.quantity);
    res.redirect('/equipment');
});

app.get('/backup', requireLogin, requireManager, async (req, res) => {
    const keys = await redis.keys('*');
    const backupData = {};
    for (let key of keys) {
        const type = await redis.type(key);
        if (type === 'hash') backupData[key] = await redis.hgetall(key);
        if (type === 'zset') backupData[key] = await redis.zrange(key, 0, -1, 'WITHSCORES');
    }
    res.setHeader('Content-disposition', 'attachment; filename=database_backup.json');
    res.setHeader('Content-type', 'application/json');
    res.send(JSON.stringify(backupData, null, 2));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));