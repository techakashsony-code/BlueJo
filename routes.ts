import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { dbStore, DatabaseState, UserDoc, PostDoc, ReelDoc, StoryDoc, CommentDoc, LikeDoc, FollowDoc, NotificationDoc, MessageDoc, ConversationDoc, ReportDoc, BlockDoc } from './db.js';
import { realtimeServer } from './ws.js';

export const apiRouter = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'bluejo_jwt_secret_super_secure_key_2026';
const LEGACY_JWT_SECRET = 'bharatgram_jwt_secret_super_secure_key_2026';
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function decodeUserToken(token: string): { id: string; username?: string; tokenVersion?: number } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { id: string; username?: string; tokenVersion?: number };
  } catch {
    try {
      return jwt.verify(token, LEGACY_JWT_SECRET) as { id: string; username?: string; tokenVersion?: number };
    } catch {
      return null;
    }
  }
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || (file.mimetype.startsWith('video') ? '.mp4' : '.jpg');
    const unique = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max for video
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file format. Please upload JPG, PNG, WEBP, MP4, or WebM.'));
    }
  }
});

// Middleware: Extract Authenticated User (optional or mandatory)
export interface AuthRequest extends Request {
  user?: UserDoc;
}

export function authenticateUser(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  const token = header.split(' ')[1];
  const decoded = decodeUserToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  const state = dbStore.getState();
  const user = state.users.find(u => u._id === decoded.id && !u.isSuspended);
  if (!user) {
    return res.status(401).json({ error: 'User not found or account is suspended.' });
  }

  // Token revocation check for logout from all devices
  if (user.tokenVersion !== undefined && decoded.tokenVersion !== undefined && decoded.tokenVersion < user.tokenVersion) {
    return res.status(401).json({ error: 'Session expired or logged out from all devices. Please log in again.' });
  }

  req.user = user;
  next();
}

export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.split(' ')[1];
    const decoded = decodeUserToken(token);
    if (decoded) {
      const state = dbStore.getState();
      const user = state.users.find(u => u._id === decoded.id && !u.isSuspended);
      if (user) {
        if (user.tokenVersion === undefined || decoded.tokenVersion === undefined || decoded.tokenVersion >= user.tokenVersion) {
          req.user = user;
        }
      }
    }
  }
  next();
}

function safeUser(u?: UserDoc | null): any {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

export function getCreatorRankings(state: DatabaseState): Map<string, { rank: number; score: number }> {
  const userScores = state.users.map(u => {
    if (u.isSuspended) {
      return { userId: u._id, score: -1, createdAt: new Date(u.createdAt).getTime() };
    }

    const followers = state.follows.filter(f => f.followingId === u._id && f.status === 'accepted').length;
    const userPosts = state.posts.filter(p => p.userId === u._id);
    const userReels = state.reels.filter(r => r.userId === u._id);

    const postLikes = state.likes.filter(l => l.targetType === 'post' && userPosts.some(p => p._id === l.targetId)).length;
    const reelLikes = state.likes.filter(l => l.targetType === 'reel' && userReels.some(r => r._id === l.targetId)).length;
    const commentsReceived = state.comments.filter(c =>
      (c.targetType === 'post' && userPosts.some(p => p._id === c.targetId)) ||
      (c.targetType === 'reel' && userReels.some(r => r._id === c.targetId))
    ).length;
    const reelViews = userReels.reduce((sum, r) => sum + (r.viewsCount || 0), 0);

    // Dynamic BLUEJO engagement scoring:
    // Followers: 30 pts each
    // Posts & Reels authored: 15 pts each
    // Likes received: 6 pts each
    // Comments received: 8 pts each
    // Reel views: 0.05 pts each
    // BLUEJO Verified Creator bonus: 40 pts
    const score = (followers * 30) +
                  (userPosts.length * 15) +
                  (userReels.length * 15) +
                  ((postLikes + reelLikes) * 6) +
                  (commentsReceived * 8) +
                  Math.floor(reelViews * 0.05) +
                  (u.isVerified ? 40 : 0);

    return {
      userId: u._id,
      score,
      createdAt: new Date(u.createdAt).getTime()
    };
  });

  // Sort descending by score; if tied, older accounts get preference
  userScores.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt);

  const rankMap = new Map<string, { rank: number; score: number }>();
  userScores.forEach((item, index) => {
    rankMap.set(item.userId, { rank: index + 1, score: Math.max(0, item.score) });
  });

  return rankMap;
}

function getBlockedUserIds(userId?: string): string[] {
  if (!userId) return [];
  const state = dbStore.getState();
  const blockedByMe = state.blocks.filter(b => b.blockerId === userId).map(b => b.blockedId);
  const blockedMe = state.blocks.filter(b => b.blockedId === userId).map(b => b.blockerId);
  return Array.from(new Set([...blockedByMe, ...blockedMe]));
}

// -------------------------------------------------------------
// MEDIA UPLOAD & HTTP RANGE STREAMING
// -------------------------------------------------------------
const handleUpload = (req: AuthRequest, res: Response) => {
  const file = req.file || (req.files && (req.files as Express.Multer.File[])[0]);
  if (!file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  const isVideo = file.mimetype.startsWith('video');
  const mediaUrl = `/api/media/${file.filename}`;

  return res.json({
    success: true,
    url: mediaUrl,
    mediaUrl,
    filename: file.filename,
    mediaType: isVideo ? 'video' : 'image',
    size: file.size,
    mimetype: file.mimetype
  });
};

apiRouter.post('/media/upload', optionalAuth, upload.any(), handleUpload);
apiRouter.post('/upload', optionalAuth, upload.any(), handleUpload);

// Update Official BLUEJO Logo (transparent PNG)
apiRouter.post('/logo/update', optionalAuth, upload.single('logo'), (req: AuthRequest, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No logo file uploaded.' });
  }

  try {
    const publicDir = path.join(process.cwd(), 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }

    const destPath = path.join(publicDir, 'bluejo-logo.png');
    const uploadedPath = req.file.path;
    fs.copyFileSync(uploadedPath, destPath);

    // Also update favicon and src asset
    const favPath = path.join(publicDir, 'favicon.png');
    fs.copyFileSync(uploadedPath, favPath);

    const srcAssetPath = path.join(process.cwd(), 'src', 'assets', 'bluejo-logo.png');
    if (fs.existsSync(path.dirname(srcAssetPath))) {
      fs.copyFileSync(uploadedPath, srcAssetPath);
    }

    return res.json({
      success: true,
      message: 'Official BLUEJO logo updated successfully!',
      logoUrl: '/bluejo-logo.png?v=' + Date.now()
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to update logo: ' + err.message });
  }
});

apiRouter.get('/media/:filename', (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filename).toLowerCase();

  let mimeType = 'application/octet-stream';
  if (ext === '.mp4') mimeType = 'video/mp4';
  else if (ext === '.webm') mimeType = 'video/webm';
  else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
  else if (ext === '.png') mimeType = 'image/png';
  else if (ext === '.webp') mimeType = 'image/webp';
  else if (ext === '.gif') mimeType = 'image/gif';

  const range = req.headers.range;

  if (range) {
    // HTTP 206 Range request for video streaming
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    const fileStream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// -------------------------------------------------------------
// AUTHENTICATION ROUTES & OTP STORE
// -------------------------------------------------------------
interface PendingVerification {
  email: string;
  otp: string;
  type: 'signup' | 'forgot_password';
  userData?: {
    name: string;
    username: string;
    email: string;
    passwordHash: string;
    dob?: string;
    profilePhoto?: string;
  };
  expiresAt: number;
}

const pendingVerifications = new Map<string, PendingVerification>();

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 1. Sign up initiation: validate fields, hash password, generate email verification OTP
apiRouter.post('/auth/register-initiate', (req: Request, res: Response) => {
  const { name, username, email, password, confirmPassword, dob, profilePhoto } = req.body;

  if (!name || !username || !email || !password) {
    return res.status(400).json({ error: 'Name, username, email, and password are required.' });
  }

  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_.]/g, '');
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters and alphanumeric.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (!dob) {
    return res.status(400).json({ error: 'Date of birth is required.' });
  }

  // Validate age (must be at least 13 years old)
  const birthDate = new Date(dob);
  if (isNaN(birthDate.getTime())) {
    return res.status(400).json({ error: 'Please provide a valid date of birth.' });
  }
  const ageDiff = Date.now() - birthDate.getTime();
  const ageDate = new Date(ageDiff);
  const age = Math.abs(ageDate.getUTCFullYear() - 1970);
  if (age < 13) {
    return res.status(400).json({ error: 'You must be at least 13 years old to join BLUEJO.' });
  }

  const state = dbStore.getState();
  const existingUser = state.users.find(
    u => u.username.toLowerCase() === cleanUsername || u.email.toLowerCase() === cleanEmail
  );
  if (existingUser) {
    if (existingUser.username.toLowerCase() === cleanUsername) {
      return res.status(400).json({ error: 'This username is already taken. Please choose another.' });
    }
    return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);
  const otp = generateOtp();

  // Save in pending verifications (valid for 10 minutes)
  pendingVerifications.set(cleanEmail, {
    email: cleanEmail,
    otp,
    type: 'signup',
    userData: {
      name: name.trim(),
      username: cleanUsername,
      email: cleanEmail,
      passwordHash,
      dob,
      profilePhoto: profilePhoto || ''
    },
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  console.log(`[BLUEJO AUTH] Verification OTP for ${cleanEmail}: ${otp}`);

  return res.status(200).json({
    success: true,
    message: `Verification code sent to ${cleanEmail}. Please enter the 6-digit code to activate your account.`,
    email: cleanEmail,
    demoOtp: otp
  });
});

// 2. Verify OTP and complete account creation or password reset
apiRouter.post('/auth/verify-otp', (req: Request, res: Response) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and 6-digit OTP code are required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const pending = pendingVerifications.get(cleanEmail);

  if (!pending) {
    return res.status(400).json({ error: 'No pending verification found or code has expired. Please request a new code.' });
  }

  if (Date.now() > pending.expiresAt) {
    pendingVerifications.delete(cleanEmail);
    return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
  }

  if (pending.otp.trim() !== otp.trim()) {
    return res.status(400).json({ error: 'Incorrect 6-digit code. Please check and try again.' });
  }

  // Handle Signup OTP verification
  if (pending.type === 'signup' && pending.userData) {
    const state = dbStore.getState();
    const uData = pending.userData;
    const now = new Date().toISOString();

    const avatarIndex = (state.users.length % 6) + 1;
    const defaultAvatars = [
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=400&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1532375810709-75b1da00537c?w=400&auto=format&fit=crop&q=80'
    ];

    const newUser: UserDoc = {
      _id: `u_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      name: uData.name,
      username: uData.username,
      email: uData.email,
      passwordHash: uData.passwordHash,
      profilePhoto: uData.profilePhoto || defaultAvatars[avatarIndex - 1],
      bio: 'Hello! I just joined BLUEJO 🚀',
      website: '',
      location: '',
      dob: uData.dob,
      isEmailVerified: true,
      tokenVersion: 0,
      isVerified: false,
      isPrivate: false,
      isAdmin: false,
      isSuspended: false,
      followersCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: now,
      updatedAt: now
    };

    state.users.push(newUser);

    // Auto-follow official BLUEJO account
    const official = state.users.find(u => u.username === 'bluejo' || u.username === 'bharatgram');
    if (official) {
      state.follows.push({
        _id: `f_${Date.now()}`,
        followerId: newUser._id,
        followingId: official._id,
        status: 'accepted',
        createdAt: now
      });
      newUser.followingCount = 1;
      official.followersCount += 1;
    }

    dbStore.save();
    pendingVerifications.delete(cleanEmail);

    const token = jwt.sign(
      { id: newUser._id, username: newUser.username, tokenVersion: 0 },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.status(201).json({
      success: true,
      message: 'Account verified successfully! Welcome to BLUEJO.',
      user: safeUser(newUser),
      token
    });
  }

  // Handle Forgot Password OTP verification
  if (pending.type === 'forgot_password') {
    return res.json({
      success: true,
      verified: true,
      message: 'Code verified successfully. You can now choose a new password.'
    });
  }

  return res.status(400).json({ error: 'Invalid verification request.' });
});

// 3. Resend OTP
apiRouter.post('/auth/resend-otp', (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const cleanEmail = email.trim().toLowerCase();
  const pending = pendingVerifications.get(cleanEmail);

  if (!pending) {
    return res.status(400).json({ error: 'No active verification session. Please sign up or request password reset again.' });
  }

  const newOtp = generateOtp();
  pending.otp = newOtp;
  pending.expiresAt = Date.now() + 10 * 60 * 1000;
  pendingVerifications.set(cleanEmail, pending);

  console.log(`[BLUEJO AUTH] Resent OTP for ${cleanEmail}: ${newOtp}`);

  return res.json({
    success: true,
    message: `A new 6-digit code has been sent to ${cleanEmail}.`,
    demoOtp: newOtp
  });
});

// 4. Standard Register (direct fallback)
apiRouter.post('/auth/register', (req: Request, res: Response) => {
  const { name, username, email, password, dob, profilePhoto } = req.body;

  if (!name || !username || !email || !password) {
    return res.status(400).json({ error: 'All fields (name, username, email, password) are required.' });
  }

  const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_.]/g, '');
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters long and alphanumeric.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const state = dbStore.getState();
  const existingUser = state.users.find(u => u.username.toLowerCase() === cleanUsername || u.email.toLowerCase() === cleanEmail);
  if (existingUser) {
    return res.status(400).json({ error: 'Username or email already in use.' });
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);
  const now = new Date().toISOString();

  const avatarIndex = (state.users.length % 6) + 1;
  const defaultAvatars = [
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=400&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1532375810709-75b1da00537c?w=400&auto=format&fit=crop&q=80'
  ];

  const newUser: UserDoc = {
    _id: `u_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    name: name.trim(),
    username: cleanUsername,
    email: cleanEmail,
    passwordHash,
    profilePhoto: profilePhoto || defaultAvatars[avatarIndex - 1],
    bio: `Hello! New on BLUEJO`,
    website: '',
    location: '',
    dob: dob || '',
    isEmailVerified: true,
    tokenVersion: 0,
    isVerified: false,
    isPrivate: false,
    isAdmin: false,
    isSuspended: false,
    followersCount: 0,
    followingCount: 0,
    postCount: 0,
    createdAt: now,
    updatedAt: now
  };

  state.users.push(newUser);

  const official = state.users.find(u => u.username === 'bluejo' || u.username === 'bharatgram');
  if (official) {
    state.follows.push({
      _id: `f_${Date.now()}`,
      followerId: newUser._id,
      followingId: official._id,
      status: 'accepted',
      createdAt: now
    });
    newUser.followingCount = 1;
    official.followersCount += 1;
  }

  dbStore.save();

  const token = jwt.sign(
    { id: newUser._id, username: newUser.username, tokenVersion: 0 },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return res.status(201).json({
    success: true,
    user: safeUser(newUser),
    token
  });
});

// 5. Login with email or username + password
apiRouter.post('/auth/login', (req: Request, res: Response) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/Email and password are required.' });
  }

  const clean = identifier.trim().toLowerCase();
  const state = dbStore.getState();
  const user = state.users.find(u => u.username.toLowerCase() === clean || u.email.toLowerCase() === clean);

  if (!user) {
    return res.status(401).json({ error: 'No BLUEJO account found with these credentials. Please check or sign up.' });
  }

  if (user.isSuspended) {
    return res.status(403).json({ error: 'This BLUEJO account has been suspended by administration.' });
  }

  const match = bcrypt.compareSync(password, user.passwordHash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect password. Please try again or reset your password.' });
  }

  const currentVersion = user.tokenVersion || 0;
  const token = jwt.sign(
    { id: user._id, username: user.username, tokenVersion: currentVersion },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return res.json({
    success: true,
    user: safeUser(user),
    token,
    message: 'Welcome back to BLUEJO!'
  });
});

// 6. Google Sign-In
apiRouter.post('/auth/google', (req: Request, res: Response) => {
  const { email, name, avatar, googleId } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Google email is required.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const state = dbStore.getState();
  let user = state.users.find(u => u.email.toLowerCase() === cleanEmail);
  const now = new Date().toISOString();

  if (user) {
    if (user.isSuspended) {
      return res.status(403).json({ error: 'This account has been suspended.' });
    }
    if (googleId && !user.googleId) {
      user.googleId = googleId;
      dbStore.save();
    }
  } else {
    // Generate clean username from name or email
    const baseUsername = (name || cleanEmail.split('@')[0])
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .slice(0, 15);
    let candidateUsername = baseUsername;
    let counter = 1;
    while (state.users.some(u => u.username.toLowerCase() === candidateUsername)) {
      candidateUsername = `${baseUsername}_${counter}`;
      counter++;
    }

    const salt = bcrypt.genSaltSync(10);
    const randomPass = crypto.randomBytes(16).toString('hex');
    const passwordHash = bcrypt.hashSync(randomPass, salt);

    user = {
      _id: `u_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      name: name || candidateUsername,
      username: candidateUsername,
      email: cleanEmail,
      passwordHash,
      profilePhoto: avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&auto=format&fit=crop&q=80',
      bio: 'Hello! Connected via Google on BLUEJO 🌐',
      website: '',
      location: '',
      isEmailVerified: true,
      tokenVersion: 0,
      googleId: googleId || `g_${Date.now()}`,
      isVerified: false,
      isPrivate: false,
      isAdmin: false,
      isSuspended: false,
      followersCount: 0,
      followingCount: 0,
      postCount: 0,
      createdAt: now,
      updatedAt: now
    };

    state.users.push(user);

    // Auto-follow official BLUEJO account
    const official = state.users.find(u => u.username === 'bluejo' || u.username === 'bharatgram');
    if (official) {
      state.follows.push({
        _id: `f_${Date.now()}`,
        followerId: user._id,
        followingId: official._id,
        status: 'accepted',
        createdAt: now
      });
      user.followingCount = 1;
      official.followersCount += 1;
    }

    dbStore.save();
  }

  const token = jwt.sign(
    { id: user._id, username: user.username, tokenVersion: user.tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return res.json({
    success: true,
    user: safeUser(user),
    token,
    message: 'Authenticated with Google successfully!'
  });
});

// 7. Firebase Auth Sync (Handles Email, Phone, and Google Firebase sign-ins)
apiRouter.post('/auth/firebase-sync', (req: Request, res: Response) => {
  const {
    firebaseUid,
    email,
    phoneNumber,
    name,
    username,
    profilePhoto,
    dob,
    isEmailVerified,
    isPhoneVerified
  } = req.body;

  if (!firebaseUid) {
    return res.status(400).json({ error: 'Firebase UID is required.' });
  }

  const state = dbStore.getState();
  const cleanEmail = email ? String(email).trim().toLowerCase() : '';
  const cleanPhone = phoneNumber ? String(phoneNumber).trim() : '';

  // Look for existing user by firebaseUid, email, or phone
  let user = state.users.find(u =>
    (u.firebaseUid && u.firebaseUid === firebaseUid) ||
    (cleanEmail && u.email && u.email.toLowerCase() === cleanEmail) ||
    (cleanPhone && u.phoneNumber && u.phoneNumber === cleanPhone)
  );

  const now = new Date().toISOString();

  if (user) {
    if (user.isSuspended) {
      return res.status(403).json({ error: 'This BLUEJO account has been suspended.' });
    }
    // Update firebaseUid, verification flags, and phone
    user.firebaseUid = firebaseUid;
    if (cleanPhone) user.phoneNumber = cleanPhone;
    if (isEmailVerified !== undefined) user.isEmailVerified = Boolean(isEmailVerified);
    if (isPhoneVerified !== undefined) user.isPhoneVerified = Boolean(isPhoneVerified);
    if (profilePhoto && !user.profilePhoto) user.profilePhoto = profilePhoto;
    if (name && (!user.name || user.name === user.username)) user.name = name.trim();
    user.updatedAt = now;
    dbStore.save();
  } else {
    // New user creation from Firebase
    let baseUsername = '';
    if (username) {
      baseUsername = username.trim().toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20);
    } else if (cleanEmail) {
      baseUsername = cleanEmail.split('@')[0].toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20);
    } else if (cleanPhone) {
      baseUsername = 'user_' + cleanPhone.replace(/[^0-9]/g, '').slice(-6);
    } else {
      baseUsername = 'bluejo_user';
    }

    let candidateUsername = baseUsername || 'user';
    let counter = 1;
    while (state.users.some(u => u.username.toLowerCase() === candidateUsername)) {
      candidateUsername = `${baseUsername}_${counter}`;
      counter++;
    }

    const salt = bcrypt.genSaltSync(10);
    const randomPass = crypto.randomBytes(16).toString('hex');
    const passwordHash = bcrypt.hashSync(randomPass, salt);

    user = {
      _id: `u_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      name: name?.trim() || candidateUsername,
      username: candidateUsername,
      email: cleanEmail || `${candidateUsername}@bluejo.user`,
      passwordHash,
      profilePhoto: profilePhoto || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&auto=format&fit=crop&q=80',
      bio: cleanPhone ? 'Hello! Connected via Mobile on BLUEJO 📱' : 'Hello! I just joined BLUEJO 🚀',
      website: '',
      location: '',
      dob: dob || '2000-01-01',
      isEmailVerified: Boolean(isEmailVerified),
      tokenVersion: 0,
      firebaseUid,
      phoneNumber: cleanPhone,
      isPhoneVerified: Boolean(isPhoneVerified),
      isVerified: false,
      isPrivate: false,
      isAdmin: false,
      isSuspended: false,
      followersCount: 0,
      followingCount: 1,
      postCount: 0,
      createdAt: now,
      updatedAt: now
    };

    state.users.push(user);

    // Auto-follow official account
    const official = state.users.find(u => u.username === 'bluejo' || u.username === 'bharatgram');
    if (official) {
      state.follows.push({
        _id: `f_${Date.now()}`,
        followerId: user._id,
        followingId: official._id,
        status: 'accepted',
        createdAt: now
      });
      user.followingCount = 1;
      official.followersCount += 1;
    }

    dbStore.save();
  }

  const currentVersion = user.tokenVersion || 0;
  const token = jwt.sign(
    { id: user._id, username: user.username, tokenVersion: currentVersion },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return res.json({
    success: true,
    user: safeUser(user),
    token,
    message: 'Authenticated with Firebase successfully!'
  });
});

// 8. Get Current Authenticated User Session
apiRouter.get('/auth/me', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const state = dbStore.getState();

  const unreadNotifications = state.notifications.filter(n => n.recipientId === user._id && !n.isRead).length;
  const unreadMessages = state.messages.filter(m => m.receiverId === user._id && !m.isRead).length;

  const rankings = getCreatorRankings(state);
  const userRank = rankings.get(user._id)?.rank || 1;

  return res.json({
    success: true,
    user: {
      ...safeUser(user),
      creatorRank: userRank
    },
    unreadNotifications,
    unreadMessages
  });
});

// 8. Forgot Password: send 6-digit OTP to user's registered email
apiRouter.post('/auth/forgot-password', (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Please enter your registered email address.' });

  const cleanEmail = email.trim().toLowerCase();
  const state = dbStore.getState();
  const user = state.users.find(u => u.email.toLowerCase() === cleanEmail);

  if (!user) {
    return res.status(404).json({ error: 'No BLUEJO account registered with this email address.' });
  }

  const otp = generateOtp();
  pendingVerifications.set(cleanEmail, {
    email: cleanEmail,
    otp,
    type: 'forgot_password',
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  console.log(`[BLUEJO AUTH] Password Reset OTP for ${cleanEmail}: ${otp}`);

  return res.json({
    success: true,
    message: `Password reset 6-digit code has been sent to ${cleanEmail}.`,
    email: cleanEmail,
    demoOtp: otp
  });
});

// 9. Reset Password with OTP & new password
apiRouter.post('/auth/reset-password', (req: Request, res: Response) => {
  const { email, otp, newPassword, confirmPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ error: 'Email, OTP code, and new password are required.' });
  }

  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const pending = pendingVerifications.get(cleanEmail);

  if (!pending || pending.type !== 'forgot_password') {
    return res.status(400).json({ error: 'No active password reset request found or code expired.' });
  }

  if (Date.now() > pending.expiresAt) {
    pendingVerifications.delete(cleanEmail);
    return res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
  }

  if (pending.otp.trim() !== otp.trim()) {
    return res.status(400).json({ error: 'Invalid 6-digit reset code. Please check and try again.' });
  }

  const state = dbStore.getState();
  const user = state.users.find(u => u.email.toLowerCase() === cleanEmail);
  if (!user) {
    return res.status(404).json({ error: 'User account not found.' });
  }

  const salt = bcrypt.genSaltSync(10);
  user.passwordHash = bcrypt.hashSync(newPassword, salt);
  // Increment tokenVersion so all previous sessions are invalidated!
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.updatedAt = new Date().toISOString();
  dbStore.save();

  pendingVerifications.delete(cleanEmail);

  // Generate new token for the user
  const token = jwt.sign(
    { id: user._id, username: user.username, tokenVersion: user.tokenVersion },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  return res.json({
    success: true,
    message: 'Your BLUEJO password has been updated securely. Previous sessions on other devices were signed out.',
    token,
    user: safeUser(user)
  });
});

// 10. Logout endpoint
apiRouter.post('/auth/logout', optionalAuth, (req: AuthRequest, res: Response) => {
  return res.json({ success: true, message: 'Logged out successfully.' });
});

// 11. Logout from all devices (invalidates all tokens across all sessions)
apiRouter.post('/auth/logout-all', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.updatedAt = new Date().toISOString();
  dbStore.save();

  return res.json({
    success: true,
    message: 'Successfully logged out from all devices. All other active sessions have been terminated.'
  });
});

// -------------------------------------------------------------
// USER & PROFILE ROUTES
// -------------------------------------------------------------
const handleGetUserProfile = (req: AuthRequest, res: Response, next: any) => {
  const targetParam = (req.params.username || '').toLowerCase();
  const reserved = ['suggestions', 'suggested', 'profile', 'change-password', 'follow-requests', 'update', 'search'];
  if (reserved.includes(targetParam)) {
    return next();
  }

  const state = dbStore.getState();
  const user = state.users.find(
    u => u.username.toLowerCase() === targetParam || u._id.toLowerCase() === targetParam
  );

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found.' });
  }

  const currentUserId = req.user?._id;
  const isMe = currentUserId === user._id;

  // Real database calculation of followers, following, posts, reels
  const realFollowersCount = state.follows.filter(f => f.followingId === user._id && f.status === 'accepted').length;
  const realFollowingCount = state.follows.filter(f => f.followerId === user._id && f.status === 'accepted').length;
  const realPostCount = state.posts.filter(p => p.userId === user._id).length;
  const realReelCount = state.reels.filter(r => r.userId === user._id).length;

  const isFollowing = currentUserId
    ? state.follows.some(f => f.followerId === currentUserId && f.followingId === user._id && f.status === 'accepted')
    : false;

  const isFollowPending = currentUserId
    ? state.follows.some(f => f.followerId === currentUserId && f.followingId === user._id && f.status === 'pending')
    : false;

  const isBlockedByMe = currentUserId
    ? state.blocks.some(b => b.blockerId === currentUserId && b.blockedId === user._id)
    : false;

  const isPrivateHidden = user.isPrivate && !isMe && !isFollowing;

  // Enrich user posts
  let userPosts: any[] = [];
  let userReels: any[] = [];
  let userSavedPosts: any[] = [];

  if (!isPrivateHidden) {
    const rawPosts = state.posts
      .filter(p => p.userId === user._id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    userPosts = rawPosts.map(p => {
      const likesCount = state.likes.filter(l => l.targetType === 'post' && l.targetId === p._id).length;
      const commentsCount = state.comments.filter(c => c.targetType === 'post' && c.targetId === p._id).length;
      const isLikedByMe = currentUserId
        ? state.likes.some(l => l.targetType === 'post' && l.targetId === p._id && l.userId === currentUserId)
        : false;
      const isSavedByMe = currentUserId
        ? state.savedPosts.some(s => s.targetType === 'post' && s.targetId === p._id && s.userId === currentUserId)
        : false;

      return {
        ...p,
        likesCount,
        commentsCount,
        isLikedByMe,
        isSavedByMe,
        author: safeUser(user)
      };
    });

    const rawReels = state.reels
      .filter(r => r.userId === user._id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    userReels = rawReels.map(r => {
      const likesCount = state.likes.filter(l => l.targetType === 'reel' && l.targetId === r._id).length;
      const commentsCount = state.comments.filter(c => c.targetType === 'reel' && c.targetId === r._id).length;
      const isLikedByMe = currentUserId
        ? state.likes.some(l => l.targetType === 'reel' && l.targetId === r._id && l.userId === currentUserId)
        : false;
      const isSavedByMe = currentUserId
        ? state.savedPosts.some(s => s.targetType === 'reel' && s.targetId === r._id && s.userId === currentUserId)
        : false;

      return {
        ...r,
        likesCount,
        commentsCount,
        isLikedByMe,
        isSavedByMe,
        author: safeUser(user)
      };
    });
  }

  if (isMe) {
    const savedPostDocs = state.savedPosts
      .filter(s => s.userId === user._id && s.targetType === 'post')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    userSavedPosts = savedPostDocs
      .map(saved => {
        const post = state.posts.find(p => p._id === saved.targetId);
        if (!post) return null;
        const author = state.users.find(u => u._id === post.userId);
        if (!author) return null;
        return {
          ...post,
          likesCount: state.likes.filter(l => l.targetType === 'post' && l.targetId === post._id).length,
          commentsCount: state.comments.filter(c => c.targetType === 'post' && c.targetId === post._id).length,
          isLikedByMe: currentUserId ? state.likes.some(l => l.targetType === 'post' && l.targetId === post._id && l.userId === currentUserId) : false,
          isSavedByMe: true,
          author: safeUser(author)
        };
      })
      .filter(Boolean);
  }

  const rankings = getCreatorRankings(state);
  const userRank = rankings.get(user._id)?.rank || 1;

  return res.json({
    success: true,
    user: {
      ...safeUser(user),
      followersCount: realFollowersCount,
      followingCount: realFollowingCount,
      postCount: realPostCount,
      reelCount: realReelCount,
      creatorRank: userRank,
      isFollowing,
      isFollowPending,
      isBlockedByMe,
      isMe
    },
    posts: userPosts,
    reels: userReels,
    savedPosts: userSavedPosts,
    isPrivateHidden
  });
};

apiRouter.get('/users/profile/:username', optionalAuth, handleGetUserProfile);
apiRouter.get('/users/:username', optionalAuth, handleGetUserProfile);

// Get Creator Leaderboard / Rankings
apiRouter.get('/creators/rankings', optionalAuth, (req: AuthRequest, res: Response) => {
  const state = dbStore.getState();
  const rankings = getCreatorRankings(state);

  const creators = state.users
    .filter(u => !u.isSuspended)
    .map(u => {
      const rankInfo = rankings.get(u._id) || { rank: 99, score: 0 };
      const followersCount = state.follows.filter(f => f.followingId === u._id && f.status === 'accepted').length;
      const postCount = state.posts.filter(p => p.userId === u._id).length;
      const reelCount = state.reels.filter(r => r.userId === u._id).length;
      return {
        ...safeUser(u),
        followersCount,
        postCount,
        reelCount,
        creatorRank: rankInfo.rank,
        creatorScore: rankInfo.score
      };
    })
    .sort((a, b) => a.creatorRank - b.creatorRank);

  return res.json({
    success: true,
    creators
  });
});

apiRouter.put('/users/profile', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { name, username, bio, website, location, profilePhoto, isPrivate } = req.body;
  const state = dbStore.getState();

  // Validate and update username if provided
  if (username && typeof username === 'string') {
    const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_.]/g, '');
    if (cleanUsername.length < 3) {
      return res.status(400).json({ success: false, error: 'Username must be at least 3 characters long.' });
    }
    if (cleanUsername !== user.username.toLowerCase()) {
      const exists = state.users.some(u => u._id !== user._id && u.username.toLowerCase() === cleanUsername);
      if (exists) {
        return res.status(400).json({ success: false, error: 'Username @' + cleanUsername + ' is already taken.' });
      }
      user.username = cleanUsername;
    }
  }

  if (name && typeof name === 'string' && name.trim()) user.name = name.trim().slice(0, 60);
  if (bio !== undefined) user.bio = String(bio).slice(0, 300);
  if (website !== undefined) user.website = String(website).slice(0, 150);
  if (location !== undefined) user.location = String(location).slice(0, 100);
  if (profilePhoto && typeof profilePhoto === 'string' && profilePhoto.trim()) {
    user.profilePhoto = profilePhoto.trim();
  }
  if (typeof isPrivate === 'boolean') user.isPrivate = isPrivate;

  user.updatedAt = new Date().toISOString();
  dbStore.save();

  return res.json({ success: true, user: safeUser(user) });
});

// Follow / Unfollow user by username or userId
const handleFollowToggle = (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const targetParam = (req.params.target || req.body.targetUserId || '').trim();

  if (!targetParam) return res.status(400).json({ success: false, error: 'Target user identifier required.' });

  const state = dbStore.getState();
  const targetUser = state.users.find(
    u => u._id === targetParam || u.username.toLowerCase() === targetParam.toLowerCase()
  );

  if (!targetUser) return res.status(404).json({ success: false, error: 'User not found.' });
  if (targetUser._id === user._id) return res.status(400).json({ success: false, error: 'You cannot follow yourself.' });

  const existingFollowIndex = state.follows.findIndex(
    f => f.followerId === user._id && f.followingId === targetUser._id
  );

  let isFollowing = false;
  let isPending = false;

  if (existingFollowIndex !== -1) {
    // Unfollow
    state.follows.splice(existingFollowIndex, 1);
    isFollowing = false;
    isPending = false;
  } else {
    // Follow
    const status = targetUser.isPrivate ? 'pending' : 'accepted';
    state.follows.push({
      _id: `f_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      followerId: user._id,
      followingId: targetUser._id,
      status,
      createdAt: new Date().toISOString()
    });

    if (status === 'accepted') {
      isFollowing = true;
    } else {
      isPending = true;
    }

    // Send notification
    const notif: NotificationDoc = {
      _id: `n_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      recipientId: targetUser._id,
      senderId: user._id,
      type: status === 'pending' ? 'follow_request' : 'follow',
      isRead: false,
      createdAt: new Date().toISOString()
    };
    state.notifications.unshift(notif);
    realtimeServer.sendToUser(targetUser._id, {
      type: 'new_notification',
      notification: notif,
      sender: safeUser(user)
    });
  }

  // Calculate and update counts immediately
  const realFollowersCount = state.follows.filter(f => f.followingId === targetUser._id && f.status === 'accepted').length;
  const realFollowingCount = state.follows.filter(f => f.followerId === user._id && f.status === 'accepted').length;
  targetUser.followersCount = realFollowersCount;
  user.followingCount = realFollowingCount;

  dbStore.save();

  return res.json({
    success: true,
    isFollowing,
    isPending,
    following: isFollowing,
    status: isFollowing ? 'accepted' : (isPending ? 'requested' : 'unfollowed'),
    followersCount: realFollowersCount,
    followingCount: realFollowingCount
  });
};

apiRouter.post('/users/:target/follow', authenticateUser, handleFollowToggle);
apiRouter.post('/follows/toggle', authenticateUser, handleFollowToggle);

// Follow requests accept/reject
apiRouter.post('/users/follow-requests/:senderId/:action', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { senderId, action } = req.params;
  const state = dbStore.getState();

  const followIndex = state.follows.findIndex(f => f.followerId === senderId && f.followingId === user._id && f.status === 'pending');
  if (action === 'accept') {
    if (followIndex !== -1) {
      state.follows[followIndex].status = 'accepted';
      const sender = state.users.find(u => u._id === senderId);
      if (sender) sender.followingCount = state.follows.filter(f => f.followerId === senderId && f.status === 'accepted').length;
      user.followersCount = state.follows.filter(f => f.followingId === user._id && f.status === 'accepted').length;
    }
  } else {
    if (followIndex !== -1) {
      state.follows.splice(followIndex, 1);
    }
  }

  // Remove follow request notification
  state.notifications = state.notifications.filter(n => !(n.recipientId === user._id && n.senderId === senderId && n.type === 'follow_request'));
  dbStore.save();
  return res.json({ success: true, action });
});

// Change password
apiRouter.post('/users/change-password', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'Both current and new passwords are required.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, error: 'New password must be at least 6 characters long.' });
  }

  const isMatch = bcrypt.compareSync(oldPassword, user.passwordHash);
  if (!isMatch) {
    return res.status(400).json({ success: false, error: 'Current password is incorrect.' });
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  user.updatedAt = new Date().toISOString();
  dbStore.save();
  return res.json({ success: true, message: 'Password updated successfully.' });
});

const handleSuggestions = (req: AuthRequest, res: Response) => {
  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const blockedIds = getBlockedUserIds(currentUserId);

  const followedIds = currentUserId
    ? new Set(state.follows.filter(f => f.followerId === currentUserId).map(f => f.followingId))
    : new Set();

  const candidates = state.users
    .filter(u => u._id !== currentUserId && !u.isSuspended && !blockedIds.includes(u._id) && !followedIds.has(u._id))
    .slice(0, 6)
    .map(u => ({
      ...safeUser(u),
      followersCount: state.follows.filter(f => f.followingId === u._id && f.status === 'accepted').length
    }));

  return res.json({ success: true, suggestions: candidates, users: candidates });
};

apiRouter.get('/users/suggestions', optionalAuth, handleSuggestions);
apiRouter.get('/users/suggested', optionalAuth, handleSuggestions);

apiRouter.get('/users/:userId/followers', optionalAuth, (req: AuthRequest, res: Response) => {
  const { userId } = req.params;
  const state = dbStore.getState();
  const currentUserId = req.user?._id;

  const targetUser = state.users.find(
    u => u._id === userId || u.username.toLowerCase() === userId.toLowerCase()
  );
  if (!targetUser) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  const followerRelations = state.follows.filter(f => f.followingId === targetUser._id && f.status === 'accepted');
  const followers = followerRelations.map(rel => {
    const u = state.users.find(user => user._id === rel.followerId);
    if (!u) return null;
    const isFollowing = currentUserId
      ? state.follows.some(f => f.followerId === currentUserId && f.followingId === u._id && f.status === 'accepted')
      : false;
    return {
      ...safeUser(u),
      isFollowing,
      isMe: currentUserId === u._id
    };
  }).filter(Boolean);

  return res.json({ success: true, users: followers, followers });
});

apiRouter.get('/users/:userId/following', optionalAuth, (req: AuthRequest, res: Response) => {
  const { userId } = req.params;
  const state = dbStore.getState();
  const currentUserId = req.user?._id;

  const targetUser = state.users.find(
    u => u._id === userId || u.username.toLowerCase() === userId.toLowerCase()
  );
  if (!targetUser) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  const followingRelations = state.follows.filter(f => f.followerId === targetUser._id && f.status === 'accepted');
  const following = followingRelations.map(rel => {
    const u = state.users.find(user => user._id === rel.followingId);
    if (!u) return null;
    const isFollowing = currentUserId
      ? state.follows.some(f => f.followerId === currentUserId && f.followingId === u._id && f.status === 'accepted')
      : false;
    return {
      ...safeUser(u),
      isFollowing,
      isMe: currentUserId === u._id
    };
  }).filter(Boolean);

  return res.json({ success: true, users: following, following });
});

// -------------------------------------------------------------
// POSTS ROUTES
// -------------------------------------------------------------
// POSTS & FEED ENDPOINTS
// -------------------------------------------------------------
const handleGetPosts = (req: AuthRequest, res: Response) => {
  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const blockedIds = getBlockedUserIds(currentUserId);

  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;
  const startIndex = (page - 1) * limit;

  // Filter out suspended and blocked creators
  const validPosts = state.posts
    .filter(p => {
      const author = state.users.find(u => u._id === p.userId);
      if (!author || author.isSuspended || blockedIds.includes(p.userId)) return false;
      if (author.isPrivate && currentUserId !== p.userId) {
        const isFollower = currentUserId ? state.follows.some(f => f.followerId === currentUserId && f.followingId === author._id && f.status === 'accepted') : false;
        if (!isFollower) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const paginatedPosts = validPosts.slice(startIndex, startIndex + limit);

  const enriched = paginatedPosts
    .map(p => {
      const author = state.users.find(u => u._id === p.userId);
      const realLikesCount = state.likes.filter(l => l.targetType === 'post' && l.targetId === p._id).length;
      const realCommentsCount = state.comments.filter(c => c.targetType === 'post' && c.targetId === p._id).length;
      const isLikedByMe = currentUserId ? state.likes.some(l => l.targetType === 'post' && l.targetId === p._id && l.userId === currentUserId) : false;
      const isSavedByMe = currentUserId ? state.savedPosts.some(s => s.targetType === 'post' && s.targetId === p._id && s.userId === currentUserId) : false;

      // Comments preview (first 2 comments)
      const commentsPreview = state.comments
        .filter(c => c.targetType === 'post' && c.targetId === p._id)
        .slice(0, 2)
        .map(c => {
          const commentAuthor = state.users.find(u => u._id === c.userId);
          return {
            ...c,
            author: commentAuthor ? safeUser(commentAuthor) : null
          };
        });

      return {
        ...p,
        likesCount: realLikesCount,
        commentsCount: realCommentsCount,
        isLikedByMe,
        isSavedByMe,
        author: safeUser(author),
        commentsPreview
      };
    })
    .filter(p => p.author !== null);

  return res.json({
    success: true,
    posts: enriched,
    feed: enriched,
    hasMore: startIndex + limit < validPosts.length,
    total: validPosts.length
  });
};

apiRouter.get('/posts', optionalAuth, handleGetPosts);
apiRouter.get('/feed', optionalAuth, handleGetPosts);

apiRouter.post('/posts', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { mediaUrl, mediaType, caption, location, visibility } = req.body;

  if (!mediaUrl) {
    return res.status(400).json({ error: 'Media URL or uploaded file is required.' });
  }

  // Extract hashtags from caption: e.g. #India, #Technology
  const captionText = caption || '';
  const regex = /#([a-zA-Z0-9_\u0900-\u097F]+)/g;
  const matches = captionText.match(regex) || [];
  const hashtags: string[] = Array.from(new Set<string>(matches.map(m => m.replace('#', ''))));

  const now = new Date().toISOString();
  const state = dbStore.getState();

  const newPost: PostDoc = {
    _id: `p_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    userId: user._id,
    mediaType: mediaType === 'video' ? 'video' : 'image',
    mediaUrl,
    caption: captionText,
    hashtags,
    location: location || '',
    likesCount: 0,
    commentsCount: 0,
    viewsCount: 1,
    visibility: visibility === 'private' ? 'private' : 'public',
    createdAt: now,
    updatedAt: now
  };

  state.posts.unshift(newPost);
  user.postCount = state.posts.filter(p => p.userId === user._id).length;
  dbStore.save();

  return res.status(201).json({
    success: true,
    post: {
      ...newPost,
      author: safeUser(user),
      isLikedByMe: false,
      isSavedByMe: false,
      commentsPreview: []
    }
  });
});

apiRouter.get('/posts/:id', optionalAuth, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const state = dbStore.getState();
  const post = state.posts.find(p => p._id === id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found.' });
  }

  const author = state.users.find(u => u._id === post.userId);
  if (!author || author.isSuspended) {
    return res.status(404).json({ error: 'Post author unavailable.' });
  }

  const currentUserId = req.user?._id;
  const realLikesCount = state.likes.filter(l => l.targetType === 'post' && l.targetId === post._id).length;
  const realCommentsCount = state.comments.filter(c => c.targetType === 'post' && c.targetId === post._id).length;
  const isLikedByMe = currentUserId ? state.likes.some(l => l.targetType === 'post' && l.targetId === post._id && l.userId === currentUserId) : false;
  const isSavedByMe = currentUserId ? state.savedPosts.some(s => s.targetType === 'post' && s.targetId === post._id && s.userId === currentUserId) : false;

  return res.json({
    success: true,
    post: {
      ...post,
      likesCount: realLikesCount,
      commentsCount: realCommentsCount,
      isLikedByMe,
      isSavedByMe,
      author: safeUser(author)
    }
  });
});

apiRouter.delete('/posts/:id', authenticateUser, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const state = dbStore.getState();
  const postIndex = state.posts.findIndex(p => p._id === id);

  if (postIndex === -1) {
    return res.status(404).json({ error: 'Post not found.' });
  }

  const post = state.posts[postIndex];
  if (post.userId !== user._id && !user.isAdmin) {
    return res.status(403).json({ error: 'Unauthorized to delete this post.' });
  }

  state.posts.splice(postIndex, 1);
  // Clean up likes, comments, saved
  state.likes = state.likes.filter(l => !(l.targetType === 'post' && l.targetId === id));
  state.comments = state.comments.filter(c => !(c.targetType === 'post' && c.targetId === id));
  state.savedPosts = state.savedPosts.filter(s => !(s.targetType === 'post' && s.targetId === id));

  const author = state.users.find(u => u._id === post.userId);
  if (author) {
    author.postCount = state.posts.filter(p => p.userId === author._id).length;
  }

  dbStore.save();
  return res.json({ success: true, message: 'Post deleted successfully.' });
});

// Like / unlike post
apiRouter.post('/posts/:id/like', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const state = dbStore.getState();
  const post = state.posts.find(p => p._id === id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });

  const existingIndex = state.likes.findIndex(l => l.targetType === 'post' && l.targetId === id && l.userId === user._id);
  let liked = false;
  if (existingIndex !== -1) {
    state.likes.splice(existingIndex, 1);
    liked = false;
  } else {
    state.likes.push({
      _id: `l_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      targetType: 'post',
      targetId: id,
      userId: user._id,
      createdAt: new Date().toISOString()
    });
    liked = true;
    if (post.userId !== user._id) {
      const notif: NotificationDoc = {
        _id: `n_${Date.now()}`,
        recipientId: post.userId,
        senderId: user._id,
        type: 'like_post',
        targetId: id,
        targetType: 'post',
        isRead: false,
        createdAt: new Date().toISOString()
      };
      state.notifications.unshift(notif);
      realtimeServer.sendToUser(post.userId, { type: 'new_notification', notification: notif, sender: safeUser(user) });
    }
  }
  const likesCount = state.likes.filter(l => l.targetType === 'post' && l.targetId === id).length;
  post.likesCount = likesCount;
  dbStore.save();
  return res.json({ success: true, liked, likesCount });
});

// Save / unsave post
apiRouter.post('/posts/:id/save', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const state = dbStore.getState();
  const post = state.posts.find(p => p._id === id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });

  const existingIndex = state.savedPosts.findIndex(s => s.userId === user._id && s.targetType === 'post' && s.targetId === id);
  let saved = false;
  if (existingIndex !== -1) {
    state.savedPosts.splice(existingIndex, 1);
    saved = false;
  } else {
    state.savedPosts.push({
      _id: `sp_${Date.now()}`,
      userId: user._id,
      targetType: 'post',
      targetId: id,
      createdAt: new Date().toISOString()
    });
    saved = true;
  }
  dbStore.save();
  return res.json({ success: true, saved });
});

// Get post comments
apiRouter.get('/posts/:id/comments', optionalAuth, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const comments = state.comments
    .filter(c => c.targetType === 'post' && c.targetId === id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(c => {
      const author = state.users.find(u => u._id === c.userId);
      const likesCount = state.likes.filter(l => l.targetType === 'comment' && l.targetId === c._id).length;
      const isLikedByMe = currentUserId ? state.likes.some(l => l.targetType === 'comment' && l.targetId === c._id && l.userId === currentUserId) : false;
      return {
        ...c,
        author: author ? safeUser(author) : null,
        likesCount,
        isLikedByMe
      };
    });
  return res.json({ success: true, comments });
});

// Add comment to post
apiRouter.post('/posts/:id/comments', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { text, parentId } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'Comment text required.' });

  const state = dbStore.getState();
  const post = state.posts.find(p => p._id === id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });

  const newComment: CommentDoc = {
    _id: `c_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    targetType: 'post',
    targetId: id,
    userId: user._id,
    text: text.trim().slice(0, 500),
    parentId: parentId || null,
    likesCount: 0,
    createdAt: new Date().toISOString()
  };
  state.comments.push(newComment);
  post.commentsCount = (post.commentsCount || 0) + 1;

  if (post.userId !== user._id) {
    const notif: NotificationDoc = {
      _id: `n_${Date.now()}`,
      recipientId: post.userId,
      senderId: user._id,
      type: 'comment',
      targetId: id,
      targetType: 'post',
      isRead: false,
      createdAt: new Date().toISOString()
    };
    state.notifications.unshift(notif);
    realtimeServer.sendToUser(post.userId, { type: 'new_notification', notification: notif, sender: safeUser(user) });
  }
  dbStore.save();
  return res.status(201).json({ success: true, comment: { ...newComment, author: safeUser(user), likesCount: 0, isLikedByMe: false } });
});

// -------------------------------------------------------------
// REELS ROUTES
// -------------------------------------------------------------
apiRouter.get('/reels', optionalAuth, (req: AuthRequest, res: Response) => {
  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const blockedIds = getBlockedUserIds(currentUserId);

  const validReels = state.reels
    .filter(r => {
      const author = state.users.find(u => u._id === r.userId);
      return author && !author.isSuspended && !blockedIds.includes(r.userId);
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const enriched = validReels.map(r => {
    const author = state.users.find(u => u._id === r.userId)!;
    const realLikesCount = state.likes.filter(l => l.targetType === 'reel' && l.targetId === r._id).length;
    const realCommentsCount = state.comments.filter(c => c.targetType === 'reel' && c.targetId === r._id).length;
    const isLikedByMe = currentUserId ? state.likes.some(l => l.targetType === 'reel' && l.targetId === r._id && l.userId === currentUserId) : false;
    const isSavedByMe = currentUserId ? state.savedPosts.some(s => s.targetType === 'reel' && s.targetId === r._id && s.userId === currentUserId) : false;
    const isFollowingAuthor = currentUserId ? state.follows.some(f => f.followerId === currentUserId && f.followingId === r.userId && f.status === 'accepted') : false;

    return {
      ...r,
      likesCount: realLikesCount,
      commentsCount: realCommentsCount,
      isLikedByMe,
      isSavedByMe,
      isFollowingAuthor,
      author: safeUser(author)
    };
  });

  return res.json({ success: true, reels: enriched });
});

apiRouter.post('/reels', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { videoUrl, thumbnailUrl, caption, audioTrack } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: 'Video URL is required for Reels.' });
  }

  const captionText = caption || '';
  const regex = /#([a-zA-Z0-9_\u0900-\u097F]+)/g;
  const matches = captionText.match(regex) || [];
  const hashtags: string[] = Array.from(new Set<string>(matches.map(m => m.replace('#', ''))));

  const now = new Date().toISOString();
  const state = dbStore.getState();

  const newReel: ReelDoc = {
    _id: `r_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    userId: user._id,
    videoUrl,
    thumbnailUrl,
    caption: captionText,
    hashtags,
    audioTrack: audioTrack || `Original Audio - ${user.name}`,
    likesCount: 0,
    commentsCount: 0,
    viewsCount: 1,
    createdAt: now,
    updatedAt: now
  };

  state.reels.unshift(newReel);
  dbStore.save();

  return res.status(201).json({
    success: true,
    reel: {
      ...newReel,
      author: safeUser(user),
      isLikedByMe: false,
      isSavedByMe: false,
      isFollowingAuthor: false
    }
  });
});

apiRouter.post('/reels/:id/view', optionalAuth, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const state = dbStore.getState();
  const reel = state.reels.find(r => r._id === id);

  if (!reel) {
    return res.status(404).json({ error: 'Reel not found.' });
  }

  // Increment genuine view count
  reel.viewsCount = (reel.viewsCount || 0) + 1;
  dbStore.save();

  return res.json({ success: true, viewsCount: reel.viewsCount });
});

apiRouter.delete('/reels/:id', authenticateUser, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const state = dbStore.getState();
  const index = state.reels.findIndex(r => r._id === id);

  if (index === -1) return res.status(404).json({ error: 'Reel not found.' });

  const reel = state.reels[index];
  if (reel.userId !== user._id && !user.isAdmin) {
    return res.status(403).json({ error: 'Unauthorized to delete this reel.' });
  }

  state.reels.splice(index, 1);
  state.likes = state.likes.filter(l => !(l.targetType === 'reel' && l.targetId === id));
  state.comments = state.comments.filter(c => !(c.targetType === 'reel' && c.targetId === id));
  state.savedPosts = state.savedPosts.filter(s => !(s.targetType === 'reel' && s.targetId === id));

  dbStore.save();
  return res.json({ success: true, message: 'Reel deleted successfully.' });
});

// Like / unlike reel
apiRouter.post('/reels/:id/like', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const state = dbStore.getState();
  const reel = state.reels.find(r => r._id === id);
  if (!reel) return res.status(404).json({ success: false, error: 'Reel not found.' });

  const existingIndex = state.likes.findIndex(l => l.targetType === 'reel' && l.targetId === id && l.userId === user._id);
  let liked = false;
  if (existingIndex !== -1) {
    state.likes.splice(existingIndex, 1);
    liked = false;
  } else {
    state.likes.push({
      _id: `l_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      targetType: 'reel',
      targetId: id,
      userId: user._id,
      createdAt: new Date().toISOString()
    });
    liked = true;
    if (reel.userId !== user._id) {
      const notif: NotificationDoc = {
        _id: `n_${Date.now()}`,
        recipientId: reel.userId,
        senderId: user._id,
        type: 'like_reel',
        targetId: id,
        targetType: 'reel',
        isRead: false,
        createdAt: new Date().toISOString()
      };
      state.notifications.unshift(notif);
      realtimeServer.sendToUser(reel.userId, { type: 'new_notification', notification: notif, sender: safeUser(user) });
    }
  }
  const likesCount = state.likes.filter(l => l.targetType === 'reel' && l.targetId === id).length;
  reel.likesCount = likesCount;
  dbStore.save();
  return res.json({ success: true, liked, likesCount });
});

// Save / unsave reel
apiRouter.post('/reels/:id/save', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const state = dbStore.getState();
  const reel = state.reels.find(r => r._id === id);
  if (!reel) return res.status(404).json({ success: false, error: 'Reel not found.' });

  const existingIndex = state.savedPosts.findIndex(s => s.userId === user._id && s.targetType === 'reel' && s.targetId === id);
  let saved = false;
  if (existingIndex !== -1) {
    state.savedPosts.splice(existingIndex, 1);
    saved = false;
  } else {
    state.savedPosts.push({
      _id: `sp_${Date.now()}`,
      userId: user._id,
      targetType: 'reel',
      targetId: id,
      createdAt: new Date().toISOString()
    });
    saved = true;
  }
  dbStore.save();
  return res.json({ success: true, saved });
});

// Get reel comments
apiRouter.get('/reels/:id/comments', optionalAuth, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const comments = state.comments
    .filter(c => c.targetType === 'reel' && c.targetId === id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(c => {
      const author = state.users.find(u => u._id === c.userId);
      const likesCount = state.likes.filter(l => l.targetType === 'comment' && l.targetId === c._id).length;
      const isLikedByMe = currentUserId ? state.likes.some(l => l.targetType === 'comment' && l.targetId === c._id && l.userId === currentUserId) : false;
      return {
        ...c,
        author: author ? safeUser(author) : null,
        likesCount,
        isLikedByMe
      };
    });
  return res.json({ success: true, comments });
});

// Add comment to reel
apiRouter.post('/reels/:id/comments', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const { text, parentId } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ success: false, error: 'Comment text required.' });

  const state = dbStore.getState();
  const reel = state.reels.find(r => r._id === id);
  if (!reel) return res.status(404).json({ success: false, error: 'Reel not found.' });

  const newComment: CommentDoc = {
    _id: `c_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    targetType: 'reel',
    targetId: id,
    userId: user._id,
    text: text.trim().slice(0, 500),
    parentId: parentId || null,
    likesCount: 0,
    createdAt: new Date().toISOString()
  };
  state.comments.push(newComment);
  reel.commentsCount = (reel.commentsCount || 0) + 1;

  if (reel.userId !== user._id) {
    const notif: NotificationDoc = {
      _id: `n_${Date.now()}`,
      recipientId: reel.userId,
      senderId: user._id,
      type: 'comment',
      targetId: id,
      targetType: 'reel',
      isRead: false,
      createdAt: new Date().toISOString()
    };
    state.notifications.unshift(notif);
    realtimeServer.sendToUser(reel.userId, { type: 'new_notification', notification: notif, sender: safeUser(user) });
  }
  dbStore.save();
  return res.status(201).json({ success: true, comment: { ...newComment, author: safeUser(user), likesCount: 0, isLikedByMe: false } });
});

// -------------------------------------------------------------
// STORIES ROUTES
// -------------------------------------------------------------
apiRouter.get('/stories', optionalAuth, (req: AuthRequest, res: Response) => {
  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const blockedIds = getBlockedUserIds(currentUserId);
  const now = new Date().getTime();

  // Active stories within 24h
  const activeStories = state.stories.filter(s => {
    const author = state.users.find(u => u._id === s.userId);
    if (!author || author.isSuspended || blockedIds.includes(s.userId)) return false;
    return new Date(s.expiresAt).getTime() > now;
  });

  // Group stories by creator
  const groupedByUser = new Map<string, StoryDoc[]>();
  activeStories.forEach(s => {
    if (!groupedByUser.has(s.userId)) {
      groupedByUser.set(s.userId, []);
    }
    groupedByUser.get(s.userId)!.push(s);
  });

  const storiesResponse = Array.from(groupedByUser.entries()).map(([userId, storiesList]) => {
    const author = state.users.find(u => u._id === userId)!;
    const hasUnviewed = currentUserId
      ? storiesList.some(s => !state.storyViews.some(v => v.storyId === s._id && v.userId === currentUserId))
      : true;

    return {
      userId,
      author: safeUser(author),
      hasUnviewed,
      stories: storiesList.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    };
  });

  // Put current user's story first if present
  storiesResponse.sort((a, b) => {
    if (a.userId === currentUserId) return -1;
    if (b.userId === currentUserId) return 1;
    return (b.hasUnviewed ? 1 : 0) - (a.hasUnviewed ? 1 : 0);
  });

  return res.json({ success: true, storyGroups: storiesResponse });
});

apiRouter.post('/stories', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { mediaUrl, mediaType, caption } = req.body;

  if (!mediaUrl) {
    return res.status(400).json({ error: 'Media URL is required for stories.' });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 3600000); // 24 hours expiry
  const state = dbStore.getState();

  const newStory: StoryDoc = {
    _id: `s_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    userId: user._id,
    mediaType: mediaType === 'video' ? 'video' : 'image',
    mediaUrl,
    caption: caption || '',
    viewsCount: 0,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };

  state.stories.push(newStory);
  dbStore.save();

  return res.status(201).json({ success: true, story: newStory });
});

apiRouter.post('/stories/:id/view', authenticateUser, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const state = dbStore.getState();

  const story = state.stories.find(s => s._id === id);
  if (!story) return res.status(404).json({ error: 'Story not found.' });

  const alreadyViewed = state.storyViews.some(v => v.storyId === id && v.userId === user._id);
  if (!alreadyViewed && story.userId !== user._id) {
    state.storyViews.push({
      _id: `sv_${Date.now()}`,
      storyId: id,
      userId: user._id,
      viewedAt: new Date().toISOString()
    });
    story.viewsCount = state.storyViews.filter(v => v.storyId === id).length;
    dbStore.save();
  }

  return res.json({ success: true, viewsCount: story.viewsCount });
});

apiRouter.delete('/stories/:id', authenticateUser, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const state = dbStore.getState();
  const index = state.stories.findIndex(s => s._id === id);

  if (index === -1) return res.status(404).json({ error: 'Story not found.' });

  const story = state.stories[index];
  if (story.userId !== user._id && !user.isAdmin) {
    return res.status(403).json({ error: 'Unauthorized.' });
  }

  state.stories.splice(index, 1);
  state.storyViews = state.storyViews.filter(v => v.storyId !== id);
  dbStore.save();

  return res.json({ success: true, message: 'Story deleted.' });
});

// -------------------------------------------------------------
// LIKE SYSTEM
// -------------------------------------------------------------
apiRouter.post('/likes/toggle', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { targetType, targetId } = req.body;

  if (!['post', 'reel', 'comment'].includes(targetType) || !targetId) {
    return res.status(400).json({ error: 'Valid targetType and targetId required.' });
  }

  const state = dbStore.getState();
  const existingIndex = state.likes.findIndex(l => l.targetType === targetType && l.targetId === targetId && l.userId === user._id);

  let liked = false;
  let targetCreatorId = '';

  if (targetType === 'post') {
    const post = state.posts.find(p => p._id === targetId);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    targetCreatorId = post.userId;
  } else if (targetType === 'reel') {
    const reel = state.reels.find(r => r._id === targetId);
    if (!reel) return res.status(404).json({ error: 'Reel not found.' });
    targetCreatorId = reel.userId;
  } else if (targetType === 'comment') {
    const comment = state.comments.find(c => c._id === targetId);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    targetCreatorId = comment.userId;
  }

  if (existingIndex !== -1) {
    // Unlike
    state.likes.splice(existingIndex, 1);
    liked = false;
  } else {
    // Like
    state.likes.push({
      _id: `l_${Date.now()}`,
      targetType,
      targetId,
      userId: user._id,
      createdAt: new Date().toISOString()
    });
    liked = true;

    // Send notification if not liking own content
    if (targetCreatorId && targetCreatorId !== user._id) {
      const notifType = targetType === 'post' ? 'like_post' : targetType === 'reel' ? 'like_reel' : 'like_post';
      const notif: NotificationDoc = {
        _id: `n_${Date.now()}`,
        recipientId: targetCreatorId,
        senderId: user._id,
        type: notifType,
        targetId,
        targetType,
        isRead: false,
        createdAt: new Date().toISOString()
      };
      state.notifications.unshift(notif);
      realtimeServer.sendToUser(targetCreatorId, {
        type: 'new_notification',
        notification: notif,
        sender: safeUser(user)
      });
    }
  }

  const newLikesCount = state.likes.filter(l => l.targetType === targetType && l.targetId === targetId).length;

  // Update target model like count
  if (targetType === 'post') {
    const p = state.posts.find(item => item._id === targetId);
    if (p) p.likesCount = newLikesCount;
  } else if (targetType === 'reel') {
    const r = state.reels.find(item => item._id === targetId);
    if (r) r.likesCount = newLikesCount;
  } else if (targetType === 'comment') {
    const c = state.comments.find(item => item._id === targetId);
    if (c) c.likesCount = newLikesCount;
  }

  dbStore.save();
  return res.json({ success: true, liked, likesCount: newLikesCount });
});

// -------------------------------------------------------------
// COMMENTS
// -------------------------------------------------------------
apiRouter.get('/comments', optionalAuth, (req: AuthRequest, res: Response) => {
  const { targetType, targetId } = req.query as { targetType: string; targetId: string };
  if (!targetType || !targetId) {
    return res.status(400).json({ error: 'targetType and targetId required.' });
  }

  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const blockedIds = getBlockedUserIds(currentUserId);

  const comments = state.comments
    .filter(c => c.targetType === targetType && c.targetId === targetId && !blockedIds.includes(c.userId))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(c => {
      const author = state.users.find(u => u._id === c.userId);
      const isLikedByMe = currentUserId ? state.likes.some(l => l.targetType === 'comment' && l.targetId === c._id && l.userId === currentUserId) : false;
      const realLikesCount = state.likes.filter(l => l.targetType === 'comment' && l.targetId === c._id).length;
      return {
        ...c,
        likesCount: realLikesCount,
        isLikedByMe,
        author: author ? safeUser(author) : null
      };
    });

  return res.json({ success: true, comments });
});

apiRouter.post('/comments', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { targetType, targetId, text, parentId } = req.body;

  if (!targetType || !targetId || !text || !text.trim()) {
    return res.status(400).json({ error: 'Comment text, targetType, and targetId are required.' });
  }

  if (text.length > 500) {
    return res.status(400).json({ error: 'Comment cannot exceed 500 characters.' });
  }

  const state = dbStore.getState();
  let targetCreatorId = '';

  if (targetType === 'post') {
    const post = state.posts.find(p => p._id === targetId);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    targetCreatorId = post.userId;
    post.commentsCount = (post.commentsCount || 0) + 1;
  } else if (targetType === 'reel') {
    const reel = state.reels.find(r => r._id === targetId);
    if (!reel) return res.status(404).json({ error: 'Reel not found.' });
    targetCreatorId = reel.userId;
    reel.commentsCount = (reel.commentsCount || 0) + 1;
  }

  const newComment: CommentDoc = {
    _id: `c_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    targetType,
    targetId,
    userId: user._id,
    text: text.trim(),
    parentId: parentId || null,
    likesCount: 0,
    createdAt: new Date().toISOString()
  };

  state.comments.push(newComment);

  // Send notification to author
  if (targetCreatorId && targetCreatorId !== user._id) {
    const notif: NotificationDoc = {
      _id: `n_${Date.now()}`,
      recipientId: targetCreatorId,
      senderId: user._id,
      type: parentId ? 'reply' : 'comment',
      targetId,
      targetType,
      isRead: false,
      createdAt: new Date().toISOString()
    };
    state.notifications.unshift(notif);
    realtimeServer.sendToUser(targetCreatorId, {
      type: 'new_notification',
      notification: notif,
      sender: safeUser(user)
    });
  }

  dbStore.save();

  return res.status(201).json({
    success: true,
    comment: {
      ...newComment,
      author: safeUser(user),
      likesCount: 0,
      isLikedByMe: false
    }
  });
});

apiRouter.delete('/comments/:id', authenticateUser, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const state = dbStore.getState();
  const index = state.comments.findIndex(c => c._id === id);

  if (index === -1) return res.status(404).json({ error: 'Comment not found.' });

  const comment = state.comments[index];
  if (comment.userId !== user._id && !user.isAdmin) {
    return res.status(403).json({ error: 'Unauthorized.' });
  }

  state.comments.splice(index, 1);
  state.likes = state.likes.filter(l => !(l.targetType === 'comment' && l.targetId === id));

  // Update count on target
  if (comment.targetType === 'post') {
    const p = state.posts.find(item => item._id === comment.targetId);
    if (p) p.commentsCount = state.comments.filter(c => c.targetType === 'post' && c.targetId === p._id).length;
  } else if (comment.targetType === 'reel') {
    const r = state.reels.find(item => item._id === comment.targetId);
    if (r) r.commentsCount = state.comments.filter(c => c.targetType === 'reel' && c.targetId === r._id).length;
  }

  dbStore.save();
  return res.json({ success: true, message: 'Comment deleted.' });
});

// Like / unlike comment
apiRouter.post('/comments/:id/like', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const state = dbStore.getState();
  const comment = state.comments.find(c => c._id === id);
  if (!comment) return res.status(404).json({ success: false, error: 'Comment not found.' });

  const existingIndex = state.likes.findIndex(l => l.targetType === 'comment' && l.targetId === id && l.userId === user._id);
  let liked = false;
  if (existingIndex !== -1) {
    state.likes.splice(existingIndex, 1);
    liked = false;
  } else {
    state.likes.push({
      _id: `l_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      targetType: 'comment',
      targetId: id,
      userId: user._id,
      createdAt: new Date().toISOString()
    });
    liked = true;
  }
  const likesCount = state.likes.filter(l => l.targetType === 'comment' && l.targetId === id).length;
  comment.likesCount = likesCount;
  dbStore.save();
  return res.json({ success: true, liked, likesCount });
});

// -------------------------------------------------------------
// SEARCH & EXPLORE & HASHTAGS
// -------------------------------------------------------------
apiRouter.get('/search', optionalAuth, (req: AuthRequest, res: Response) => {
  const query = ((req.query.q as string) || '').trim().toLowerCase();
  const state = dbStore.getState();
  const currentUserId = req.user?._id;
  const blockedIds = getBlockedUserIds(currentUserId);

  if (!query) {
    return res.json({ success: true, users: [], posts: [], hashtags: [] });
  }

  // Search users
  const cleanQ = query.replace('@', '');
  const matchedUsers = state.users
    .filter(u => !u.isSuspended && !blockedIds.includes(u._id) && (u.username.toLowerCase().includes(cleanQ) || u.name.toLowerCase().includes(cleanQ)))
    .slice(0, 8)
    .map(u => ({
      ...safeUser(u),
      followersCount: state.follows.filter(f => f.followingId === u._id && f.status === 'accepted').length
    }));

  // Search hashtags
  const cleanTag = query.replace('#', '');
  const hashtagCounts = new Map<string, number>();

  state.posts.forEach(p => {
    p.hashtags.forEach(tag => {
      const lower = tag.toLowerCase();
      if (lower.includes(cleanTag)) {
        hashtagCounts.set(tag, (hashtagCounts.get(tag) || 0) + 1);
      }
    });
  });

  state.reels.forEach(r => {
    r.hashtags.forEach(tag => {
      const lower = tag.toLowerCase();
      if (lower.includes(cleanTag)) {
        hashtagCounts.set(tag, (hashtagCounts.get(tag) || 0) + 1);
      }
    });
  });

  const matchedHashtags = Array.from(hashtagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Search posts by caption
  const matchedPosts = state.posts
    .filter(p => !blockedIds.includes(p.userId) && (p.caption.toLowerCase().includes(query) || p.hashtags.some(h => h.toLowerCase().includes(cleanTag))))
    .slice(0, 10)
    .map(p => {
      const author = state.users.find(u => u._id === p.userId);
      return {
        ...p,
        author: author ? safeUser(author) : null
      };
    });

  return res.json({
    success: true,
    users: matchedUsers,
    hashtags: matchedHashtags,
    posts: matchedPosts
  });
});

// Trending hashtags endpoint
apiRouter.get('/search/trending-hashtags', optionalAuth, (req: AuthRequest, res: Response) => {
  const state = dbStore.getState();
  const counts = new Map<string, number>();
  state.posts.forEach(p => p.hashtags?.forEach(h => counts.set(h, (counts.get(h) || 0) + 1)));
  state.reels.forEach(r => r.hashtags?.forEach(h => counts.set(h, (counts.get(h) || 0) + 1)));

  const trending = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return res.json({ success: true, trending, hashtags: trending });
});

apiRouter.get('/explore', optionalAuth, (req: AuthRequest, res: Response) => {
  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const blockedIds = getBlockedUserIds(currentUserId);

  const posts = state.posts
    .filter(p => !blockedIds.includes(p.userId) && p.visibility !== 'private')
    .slice(0, 12)
    .map(p => {
      const author = state.users.find(u => u._id === p.userId);
      return {
        ...p,
        author: author ? safeUser(author) : null
      };
    })
    .filter(p => p.author !== null);

  const reels = state.reels
    .filter(r => !blockedIds.includes(r.userId))
    .slice(0, 8)
    .map(r => {
      const author = state.users.find(u => u._id === r.userId);
      return {
        ...r,
        author: author ? safeUser(author) : null
      };
    })
    .filter(r => r.author !== null);

  // Calculate trending hashtags from real posts/reels
  const counts = new Map<string, number>();
  state.posts.forEach(p => p.hashtags?.forEach(h => counts.set(h, (counts.get(h) || 0) + 1)));
  state.reels.forEach(r => r.hashtags?.forEach(h => counts.set(h, (counts.get(h) || 0) + 1)));

  const trendingHashtags = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return res.json({ success: true, posts, reels, trendingHashtags });
});

const handleHashtag = (req: AuthRequest, res: Response) => {
  const tag = req.params.tag.replace('#', '').toLowerCase();
  const currentUserId = req.user?._id;
  const state = dbStore.getState();
  const blockedIds = getBlockedUserIds(currentUserId);

  const posts = state.posts
    .filter(p => !blockedIds.includes(p.userId) && p.hashtags && p.hashtags.some(h => h.toLowerCase() === tag))
    .map(p => ({
      ...p,
      author: safeUser(state.users.find(u => u._id === p.userId)!)
    }));

  const reels = state.reels
    .filter(r => !blockedIds.includes(r.userId) && r.hashtags && r.hashtags.some(h => h.toLowerCase() === tag))
    .map(r => ({
      ...r,
      author: safeUser(state.users.find(u => u._id === r.userId)!)
    }));

  return res.json({
    success: true,
    tag,
    totalCount: posts.length + reels.length,
    posts,
    reels
  });
};

apiRouter.get('/hashtags/:tag', optionalAuth, handleHashtag);
apiRouter.get('/search/hashtag/:tag', optionalAuth, handleHashtag);

// -------------------------------------------------------------
// SAVED CONTENT
// -------------------------------------------------------------
apiRouter.post('/saved/toggle', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { targetType, targetId } = req.body;

  if (!['post', 'reel'].includes(targetType) || !targetId) {
    return res.status(400).json({ error: 'Valid targetType and targetId required.' });
  }

  const state = dbStore.getState();
  const index = state.savedPosts.findIndex(s => s.userId === user._id && s.targetType === targetType && s.targetId === targetId);

  let isSaved = false;
  if (index !== -1) {
    state.savedPosts.splice(index, 1);
    isSaved = false;
  } else {
    state.savedPosts.push({
      _id: `sp_${Date.now()}`,
      userId: user._id,
      targetType,
      targetId,
      createdAt: new Date().toISOString()
    });
    isSaved = true;
  }

  dbStore.save();
  return res.json({ success: true, isSaved });
});

apiRouter.get('/saved', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const state = dbStore.getState();

  const userSaved = state.savedPosts.filter(s => s.userId === user._id);
  const items = userSaved.map(s => {
    if (s.targetType === 'post') {
      const post = state.posts.find(p => p._id === s.targetId);
      if (!post) return null;
      const author = state.users.find(u => u._id === post.userId);
      return {
        type: 'post',
        savedAt: s.createdAt,
        content: {
          ...post,
          author: author ? safeUser(author) : null
        }
      };
    } else {
      const reel = state.reels.find(r => r._id === s.targetId);
      if (!reel) return null;
      const author = state.users.find(u => u._id === reel.userId);
      return {
        type: 'reel',
        savedAt: s.createdAt,
        content: {
          ...reel,
          author: author ? safeUser(author) : null
        }
      };
    }
  }).filter(Boolean);

  return res.json({ success: true, savedItems: items });
});

// -------------------------------------------------------------
// NOTIFICATIONS
// -------------------------------------------------------------
apiRouter.get('/notifications', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const state = dbStore.getState();

  const notifs = state.notifications
    .filter(n => n.recipientId === user._id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(n => {
      const sender = state.users.find(u => u._id === n.senderId);
      return {
        ...n,
        sender: sender ? safeUser(sender) : null
      };
    });

  const unreadCount = notifs.filter(n => !n.isRead).length;

  return res.json({ success: true, notifications: notifs, unreadCount });
});

apiRouter.put('/notifications/read-all', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const state = dbStore.getState();

  state.notifications.forEach(n => {
    if (n.recipientId === user._id) {
      n.isRead = true;
    }
  });

  dbStore.save();
  return res.json({ success: true });
});

// -------------------------------------------------------------
// DIRECT MESSAGING
// -------------------------------------------------------------
apiRouter.get('/conversations', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const state = dbStore.getState();
  const blockedIds = getBlockedUserIds(user._id);

  const convos = state.conversations
    .filter(c => c.participants.includes(user._id))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(c => {
      const otherUserId = c.participants.find(id => id !== user._id);
      const otherUser = state.users.find(u => u._id === otherUserId);
      if (!otherUser || blockedIds.includes(otherUser._id)) return null;

      const unreadCount = state.messages.filter(m => m.conversationId === c._id && m.receiverId === user._id && !m.isRead).length;
      const isOnline = otherUserId ? realtimeServer.isUserOnline(otherUserId) : false;

      return {
        ...c,
        otherUser: safeUser(otherUser),
        isOnline,
        unreadCount
      };
    })
    .filter(Boolean);

  return res.json({ success: true, conversations: convos });
});

const handleGetConversationMessages = (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;
  const state = dbStore.getState();

  const conversation = state.conversations.find(c => c._id === id && c.participants.includes(user._id));
  if (!conversation) {
    return res.status(404).json({ success: false, error: 'Conversation not found.' });
  }

  // Mark messages as read
  state.messages.forEach(m => {
    if (m.conversationId === id && m.receiverId === user._id) {
      m.isRead = true;
    }
  });
  dbStore.save();

  const messages = state.messages
    .filter(m => m.conversationId === id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const otherUserId = conversation.participants.find(p => p !== user._id);
  const otherUser = state.users.find(u => u._id === otherUserId);

  return res.json({
    success: true,
    messages,
    otherUser: otherUser ? safeUser(otherUser) : null,
    isOnline: otherUserId ? realtimeServer.isUserOnline(otherUserId) : false
  });
};

apiRouter.get('/conversations/:id/messages', authenticateUser, handleGetConversationMessages);
apiRouter.get('/messages/:id', authenticateUser, handleGetConversationMessages);

apiRouter.post('/conversations/start', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { targetUserId } = req.body;

  if (!targetUserId || targetUserId === user._id) {
    return res.status(400).json({ error: 'Valid recipient required.' });
  }

  const state = dbStore.getState();
  const target = state.users.find(u => u._id === targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  let conversation = state.conversations.find(c =>
    c.participants.includes(user._id) && c.participants.includes(targetUserId)
  );

  if (!conversation) {
    const now = new Date().toISOString();
    conversation = {
      _id: `conv_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      participants: [user._id, targetUserId],
      lastMessage: '',
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now
    };
    state.conversations.unshift(conversation);
    dbStore.save();
  }

  return res.json({
    success: true,
    conversation: {
      ...conversation,
      otherUser: safeUser(target),
      isOnline: realtimeServer.isUserOnline(targetUserId),
      unreadCount: 0
    }
  });
});

apiRouter.post('/messages', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { conversationId, receiverId, text, mediaUrl } = req.body;

  if (!conversationId || !receiverId || (!text && !mediaUrl)) {
    return res.status(400).json({ error: 'conversationId, receiverId, and text/media required.' });
  }

  const state = dbStore.getState();
  const conversation = state.conversations.find(c => c._id === conversationId && c.participants.includes(user._id));
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

  const now = new Date().toISOString();
  const newMsg: MessageDoc = {
    _id: `m_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    conversationId,
    senderId: user._id,
    receiverId,
    text: (text || '').trim(),
    mediaUrl: mediaUrl || '',
    isRead: false,
    createdAt: now
  };

  state.messages.push(newMsg);
  conversation.lastMessage = newMsg.text || '📷 Media';
  conversation.lastMessageAt = now;
  conversation.updatedAt = now;

  dbStore.save();

  // Send through WebSocket to recipient
  realtimeServer.sendToUser(receiverId, {
    type: 'new_message',
    message: newMsg,
    sender: safeUser(user)
  });

  return res.status(201).json({ success: true, message: newMsg });
});

// -------------------------------------------------------------
// SAFETY: REPORTS & BLOCKING
// -------------------------------------------------------------
apiRouter.post('/reports', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { targetType, targetId, reason, details } = req.body;

  if (!targetType || !targetId || !reason) {
    return res.status(400).json({ error: 'targetType, targetId, and reason are required.' });
  }

  const validReasons = ['spam', 'harassment', 'hate', 'violence', 'nudity', 'fake_account', 'copyright', 'other'];
  if (!validReasons.includes(reason)) {
    return res.status(400).json({ error: 'Invalid report reason.' });
  }

  const state = dbStore.getState();
  const newReport: ReportDoc = {
    _id: `rep_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    reporterId: user._id,
    targetType,
    targetId,
    reason,
    details: details ? details.slice(0, 500) : '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  state.reports.push(newReport);
  dbStore.save();

  return res.status(201).json({
    success: true,
    message: 'Thank you for reporting. Our BLUEJO moderation team will review this shortly.'
  });
});

apiRouter.post('/blocks/toggle', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { targetUserId } = req.body;

  if (!targetUserId || targetUserId === user._id) {
    return res.status(400).json({ error: 'Cannot block this user.' });
  }

  const state = dbStore.getState();
  const index = state.blocks.findIndex(b => b.blockerId === user._id && b.blockedId === targetUserId);

  let isBlocked = false;
  if (index !== -1) {
    state.blocks.splice(index, 1);
    isBlocked = false;
  } else {
    state.blocks.push({
      _id: `b_${Date.now()}`,
      blockerId: user._id,
      blockedId: targetUserId,
      createdAt: new Date().toISOString()
    });
    // Remove any existing follow relationships
    state.follows = state.follows.filter(f =>
      !(f.followerId === user._id && f.followingId === targetUserId) &&
      !(f.followerId === targetUserId && f.followingId === user._id)
    );
    isBlocked = true;
  }

  dbStore.save();
  return res.json({ success: true, isBlocked });
});

apiRouter.get('/blocks', authenticateUser, (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const state = dbStore.getState();
  const blockedRecords = state.blocks.filter(b => b.blockerId === user._id);

  const blockedUsers = blockedRecords.map(b => {
    const target = state.users.find(u => u._id === b.blockedId);
    return target ? safeUser(target) : null;
  }).filter(Boolean);

  return res.json({ success: true, blockedUsers });
});

// -------------------------------------------------------------
// ADMIN DASHBOARD ROUTES (Protected)
// -------------------------------------------------------------
function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

apiRouter.get('/admin/stats', authenticateUser, requireAdmin, (req: AuthRequest, res: Response) => {
  const state = dbStore.getState();
  const totalUsers = state.users.length;
  const totalPosts = state.posts.length;
  const totalReels = state.reels.length;
  const totalReports = state.reports.length;
  const pendingReports = state.reports.filter(r => r.status === 'pending').length;
  const suspendedUsers = state.users.filter(u => u.isSuspended).length;
  const onlineUsers = realtimeServer.getOnlineUserIds().length;

  return res.json({
    success: true,
    stats: {
      totalUsers,
      totalPosts,
      totalReels,
      totalReports,
      pendingReports,
      suspendedUsers,
      onlineUsers
    }
  });
});

apiRouter.get('/admin/reports', authenticateUser, requireAdmin, (req: AuthRequest, res: Response) => {
  const state = dbStore.getState();
  const reports = state.reports.map(r => {
    const reporter = state.users.find(u => u._id === r.reporterId);
    let targetDetails: any = null;
    if (r.targetType === 'post') targetDetails = state.posts.find(p => p._id === r.targetId);
    else if (r.targetType === 'reel') targetDetails = state.reels.find(item => item._id === r.targetId);
    else if (r.targetType === 'user') {
      const u = state.users.find(item => item._id === r.targetId);
      if (u) targetDetails = safeUser(u);
    } else if (r.targetType === 'comment') targetDetails = state.comments.find(c => c._id === r.targetId);

    return {
      ...r,
      reporter: reporter ? safeUser(reporter) : null,
      targetDetails
    };
  });

  return res.json({ success: true, reports });
});

const handleReportAction = (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { action } = req.body; // 'dismiss' | 'delete_content' | 'suspend_user'

  const state = dbStore.getState();
  const report = state.reports.find(r => r._id === id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });

  if (action === 'dismiss') {
    report.status = 'dismissed';
  } else if (action === 'delete_content') {
    if (report.targetType === 'post') {
      state.posts = state.posts.filter(p => p._id !== report.targetId);
    } else if (report.targetType === 'reel') {
      state.reels = state.reels.filter(r => r._id !== report.targetId);
    } else if (report.targetType === 'comment') {
      state.comments = state.comments.filter(c => c._id !== report.targetId);
    }
    report.status = 'resolved';
  } else if (action === 'suspend_user') {
    let targetUserId = report.targetType === 'user' ? report.targetId : '';
    if (report.targetType === 'post') {
      const p = state.posts.find(item => item._id === report.targetId);
      if (p) targetUserId = p.userId;
    } else if (report.targetType === 'reel') {
      const r = state.reels.find(item => item._id === report.targetId);
      if (r) targetUserId = r.userId;
    }

    if (targetUserId) {
      const u = state.users.find(item => item._id === targetUserId);
      if (u) u.isSuspended = true;
    }
    report.status = 'resolved';
  }

  dbStore.save();
  return res.json({ success: true, message: `Report processed with action: ${action}` });
};

apiRouter.post('/admin/reports/:id/action', authenticateUser, requireAdmin, handleReportAction);
apiRouter.post('/admin/reports/:id/resolve', authenticateUser, requireAdmin, handleReportAction);

apiRouter.get('/admin/users', authenticateUser, requireAdmin, (req: AuthRequest, res: Response) => {
  const state = dbStore.getState();
  return res.json({ success: true, users: state.users.map(safeUser) });
});

apiRouter.post('/admin/users/:id/toggle-verified', authenticateUser, requireAdmin, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const state = dbStore.getState();
  const targetUser = state.users.find(u => u._id === id);
  if (!targetUser) return res.status(404).json({ error: 'User not found.' });

  targetUser.isVerified = !targetUser.isVerified;
  dbStore.save();
  return res.json({ success: true, isVerified: targetUser.isVerified });
});

apiRouter.post('/admin/users/:id/toggle-suspend', authenticateUser, requireAdmin, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const state = dbStore.getState();
  const targetUser = state.users.find(u => u._id === id);

  if (!targetUser) return res.status(404).json({ error: 'User not found.' });
  if (targetUser.isAdmin) return res.status(400).json({ error: 'Cannot suspend admin account.' });

  targetUser.isSuspended = !targetUser.isSuspended;
  dbStore.save();

  return res.json({ success: true, isSuspended: targetUser.isSuspended });
});
