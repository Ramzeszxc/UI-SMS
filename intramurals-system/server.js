const express = require('express');
const Redis = require('ioredis');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server); // Initialize Real-Time WebSockets

// --- SETUP MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'lpu-golazo-enterprise-key', resave: false, saveUninitialized: false }));

// --- REDIS CONNECTION ---
const redis = new Redis({
  host: 'redis-14178.crce272.asia-seast1-1.gcp.cloud.redislabs.com', // e.g., redis-12345.c250...
  port: 14178,                  // e.g., 12345
  password: 'IEtMGortH2OriEbfriSGMUvY6RiNF3Nw'
});

redis.on('connect', async () => {
    console.log('🏛️ Connected to Redis Cloud (LPU Golazo + Real-Time Mode)!');
    // FORCE FIX: Guarantees the 'admin' account is actually an 'admin'
    const hashedPw = await bcrypt.hash('admin123', 10);
    await redis.hset('user:admin', 'password', hashedPw, 'role', 'admin');
    console.log('Super Admin ensured: admin / admin123');
});

// --- ROLE-BASED AUTH MIDDLEWARE ---
const requireAuth = (req, res, next) => req.session.username ? next() : res.redirect('/login');
const requireRole = (roles) => (req, res, next) => {
    if (roles.includes(req.session.role)) return next();
    res.status(403).send("Security Alert: Insufficient Permissions.");
};

// --- AUTH & LOGIN ROUTES ---
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/register', async (req, res) => {
    const email = req.body.username; 
    if (!email.endsWith('@lpu.edu.ph')) return res.render('login', { error: 'Access Denied: You must use a valid @lpu.edu.ph student email.' });
    if (await redis.exists(`user:${email}`)) return res.render('login', { error: 'This university email is already registered.' });
    
    const hashedPw = await bcrypt.hash(req.body.password, 10);
    await redis.hset(`user:${email}`, 'password', hashedPw, 'role', 'student');
    res.render('login', { error: 'Registration successful! Please log in with your LPU email.' });
});

app.post('/login', async (req, res) => {
    let userData = await redis.hgetall(`user:${req.body.username}`);
    
    // --- THE ULTIMATE ADMIN OVERRIDE ---
    // If the username is admin, force the role to 'admin' in both DB and memory
    if (req.body.username === 'admin') {
        await redis.hset('user:admin', 'role', 'admin');
        userData.role = 'admin'; 
    }

    if (userData.password && await bcrypt.compare(req.body.password, userData.password)) {
        req.session.username = req.body.username;
        req.session.role = userData.role; // Will now be 'admin'
        
        // Redirect based on role
        return res.redirect(userData.role === 'student' ? '/student/dashboard' : '/dashboard');
    }
    
    res.render('login', { error: 'Invalid credentials. Please check your LPU Email or Password.' });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/', (req, res) => res.redirect('/login'));

// --- ADMIN ONLY: USER MANAGEMENT ---
app.get('/users', requireAuth, requireRole(['admin']), async (req, res) => {
    const userKeys = await redis.keys('user:*');
    const staff = [];
    for (let key of userKeys) {
        const role = await redis.hget(key, 'role');
        if (['manager', 'faculty', 'admin'].includes(role)) staff.push({ username: key.split(':')[1], role });
    }
    res.render('users', { role: req.session.role, staff });
});

app.post('/users/create', requireAuth, requireRole(['admin']), async (req, res) => {
    if (await redis.exists(`user:${req.body.username}`)) return res.redirect('/users?error=Username exists');
    const hashedPw = await bcrypt.hash(req.body.password, 10);
    await redis.hset(`user:${req.body.username}`, 'password', hashedPw, 'role', req.body.role);
    res.redirect('/users?success=Staff Account Created');
});

// --- SHARED DASHBOARD ---
app.get('/dashboard', requireAuth, requireRole(['admin', 'manager', 'faculty']), async (req, res) => {
    const stats = { totalTeams: (await redis.keys('team:*')).length, activeLoans: (await redis.keys('loan:*')).length };
    const leaderboardData = await redis.zrevrange('leaderboard:futsal', 0, -1, 'WITHSCORES');
    const leaderboard = [];
    for (let i = 0; i < leaderboardData.length; i += 2) leaderboard.push({ id: leaderboardData[i], name: await redis.hget(`team:${leaderboardData[i]}`, 'name'), score: leaderboardData[i+1] });
    const equipment = { futsalBalls: await redis.hget('equipment:futsal_balls', 'available') || 10, bibs: await redis.hget('equipment:bibs', 'available') || 20 };
    const announcement = await redis.get('global_announcement') || "No active announcements.";
    res.render('dashboard', { role: req.session.role, leaderboard, equipment, stats, announcement });
});

app.post('/dashboard/announce', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
    await redis.set('global_announcement', req.body.announcement);
    io.emit('live_update', '📢 New Announcement Posted!'); // Broadcast Update
    res.redirect('/dashboard?success=Announcement Posted');
});

// --- STUDENT ROUTES ---
app.get('/student/dashboard', requireAuth, requireRole(['student']), async (req, res) => {
    const leaderboardData = await redis.zrevrange('leaderboard:futsal', 0, -1, 'WITHSCORES');
    const leaderboard = [];
    let myTeam = null;
    for (let i = 0; i < leaderboardData.length; i += 2) {
        const teamData = await redis.hgetall(`team:${leaderboardData[i]}`);
        leaderboard.push({ ...teamData, score: leaderboardData[i+1] });
        if (teamData.captain === req.session.username) myTeam = { id: leaderboardData[i], ...teamData };
    }
    const myLoans = [];
    for (let key of await redis.keys('loan:*')) {
        const data = await redis.hgetall(key);
        if (data.borrower === req.session.username) myLoans.push(data);
    }
    const announcement = await redis.get('global_announcement') || "Welcome to the LPU Golazo Portal.";
    res.render('student', { username: req.session.username, leaderboard, myLoans, myTeam, announcement });
});

app.post('/student/apply-team', requireAuth, requireRole(['student']), async (req, res) => {
    if (await redis.exists(`team:${req.body.teamId}`)) return res.redirect('/student/dashboard?error=Team ID taken!');
    await redis.hset(`team:${req.body.teamId}`, 'name', req.body.name, 'captain', req.session.username, 'players', req.body.players, 'status', 'Pending');
    await redis.zadd('leaderboard:futsal', 0, req.body.teamId);
    io.emit('live_update', '⚽ New Team Application Submitted!'); // Broadcast
    res.redirect('/student/dashboard?success=Application Submitted');
});

app.post('/student/edit-team', requireAuth, requireRole(['student']), async (req, res) => {
    // Updates the database with the new name and players
    await redis.hset(`team:${req.body.teamId}`, 'name', req.body.name, 'players', req.body.players);
    
    // Broadcasts the real-time update to the managers
    io.emit('live_update', '⚽ A student just updated their team roster!'); 
    
    res.redirect('/student/dashboard?success=Team roster updated successfully!');
});

// --- ADVANCED TEAMS MANAGEMENT ---
// --- ADVANCED TEAMS MANAGEMENT ---
// --- ADVANCED TEAMS MANAGEMENT ---
app.get('/teams', requireAuth, requireRole(['admin', 'manager', 'faculty']), async (req, res) => {
    try {
        const searchQuery = req.query.search ? req.query.search.toLowerCase() : '';
        const statusFilter = req.query.statusFilter || 'All';

        let allTeams = [];
        const keys = await redis.keys('team:*');
        
        // Gather all teams
        for (let key of keys) {
            const teamData = await redis.hgetall(key);
            if (teamData.name) {
                allTeams.push({ id: key.split(':')[1], ...teamData });
            }
        }

        // ADVANCED SEARCH & FILTER LOGIC (CRASH-PROOFED)
        let teams = allTeams.filter(team => {
            // Using (team.property || '') prevents crashes if a field is somehow blank/missing
            const safeId = (team.id || '').toLowerCase();
            const safeName = (team.name || '').toLowerCase();
            const safePlayers = (team.players || '').toLowerCase();

            const matchesSearch = safeId.includes(searchQuery) || 
                                  safeName.includes(searchQuery) || 
                                  safePlayers.includes(searchQuery);
                                  
            const matchesStatus = statusFilter === 'All' || team.status === statusFilter;
            
            return matchesSearch && matchesStatus;
        });

        // Fetch all registered students for the Captain dropdown
        const userKeys = await redis.keys('user:*');
        let students = [];
        for (let key of userKeys) {
            if (await redis.hget(key, 'role') === 'student') students.push(key.split(':')[1]);
        }

        res.render('teams', { role: req.session.role, teams, students, searchQuery, statusFilter });
    } catch (error) {
        console.error("Search Error:", error);
        res.status(500).send("An error occurred while searching. Please try again.");
    }
});

app.post('/teams/status', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
    await redis.hset(`team:${req.body.teamId}`, 'status', req.body.status);
    io.emit('live_update', `⚽ A team status was changed to ${req.body.status}`); // Broadcast
    res.redirect('/teams');
});

app.post('/teams/score', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
    await redis.zincrby('leaderboard:futsal', req.body.points, req.body.teamId);
    io.emit('live_update', '🏆 The Live Leaderboard has been updated!'); // Broadcast
    res.redirect('/dashboard');
});

app.post('/teams/add', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
    if (await redis.exists(`team:${req.body.teamId}`)) return res.redirect('/teams?error=Team ID exists!');
    await redis.hset(`team:${req.body.teamId}`, 'name', req.body.name, 'captain', req.body.captain, 'players', req.body.players, 'status', 'Cleared');
    await redis.zadd('leaderboard:futsal', 0, req.body.teamId);
    io.emit('live_update', '⚽ A new team was manually added!'); // Broadcast
    res.redirect('/teams?success=Team added');
});

app.post('/teams/delete', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
    await redis.del(`team:${req.body.teamId}`);
    await redis.zrem('leaderboard:futsal', req.body.teamId);
    io.emit('live_update', '⚽ A team was deleted from the roster.'); // Broadcast
    res.redirect('/teams?success=Team deleted');
});

// --- EQUIPMENT ROUTE ---
app.get('/equipment', requireAuth, requireRole(['admin', 'manager', 'faculty']), async (req, res) => {
    const loans = [];
    for (let key of await redis.keys('loan:*')) loans.push({ id: key, ...(await redis.hgetall(key)) });
    const students = [];
    for (let key of await redis.keys('user:*')) {
        if (await redis.hget(key, 'role') === 'student') students.push(key.split(':')[1]);
    }
    res.render('equipment', { role: req.session.role, loans, students, prefillStudent: req.query.student || null });
});
// (Borrow, Return, History, Backup remain unchanged, just update via Server listener)
app.post('/equipment/borrow', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
    const { borrower, item, quantity } = req.body;
    await redis.hset(`loan:${Date.now()}`, { borrower, item, quantity, date: new Date().toLocaleString(), issuedBy: req.session.username });
    await redis.hincrby(`equipment:${item}`, 'available', -quantity);
    io.emit('live_update', '🏀 Equipment inventory updated!'); 
    res.redirect('/equipment?success=Gear Issued');
});
app.post('/equipment/return', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
    const loanData = await redis.hgetall(req.body.loanId);
    loanData.returnDate = new Date().toLocaleString();
    loanData.receivedBy = req.session.username;
    await redis.lpush('history:loans', JSON.stringify(loanData));
    await redis.del(req.body.loanId);
    await redis.hincrby(`equipment:${req.body.item}`, 'available', req.body.quantity);
    io.emit('live_update', '🏀 Equipment inventory updated!'); 
    res.redirect('/equipment?success=Gear Returned');
});
app.get('/history', requireAuth, requireRole(['admin', 'manager', 'faculty']), async (req, res) => {
    const historyData = await redis.lrange('history:loans', 0, -1);
    const history = historyData.map(data => JSON.parse(data));
    res.render('history', { role: req.session.role, history });
});
app.get('/backup', requireAuth, requireRole(['admin', 'manager', 'faculty']), async (req, res) => {
    const backupData = {};
    for (let key of await redis.keys('*')) {
        const type = await redis.type(key);
        if (type === 'hash') backupData[key] = await redis.hgetall(key);
        if (type === 'zset') backupData[key] = await redis.zrange(key, 0, -1, 'WITHSCORES');
        if (type === 'list') backupData[key] = await redis.lrange(key, 0, -1);
    }
    res.setHeader('Content-disposition', 'attachment; filename=lpu_golazo_backup.json');
    res.send(JSON.stringify(backupData, null, 2));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));