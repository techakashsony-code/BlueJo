import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

export interface UserDoc {
  _id: string;
  name: string;
  username: string;
  email: string;
  passwordHash: string;
  profilePhoto: string;
  bio: string;
  website: string;
  location: string;
  isVerified: boolean;
  isPrivate: boolean;
  isAdmin: boolean;
  isSuspended: boolean;
  followersCount: number;
  followingCount: number;
  postCount: number;
  creatorRank?: number;
  dob?: string;
  isEmailVerified?: boolean;
  tokenVersion?: number;
  googleId?: string;
  firebaseUid?: string;
  phoneNumber?: string;
  isPhoneVerified?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PostDoc {
  _id: string;
  userId: string;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  thumbnailUrl?: string;
  caption: string;
  hashtags: string[];
  location: string;
  likesCount: number;
  commentsCount: number;
  viewsCount: number;
  visibility: 'public' | 'private';
  createdAt: string;
  updatedAt: string;
}

export interface ReelDoc {
  _id: string;
  userId: string;
  videoUrl: string;
  thumbnailUrl?: string;
  caption: string;
  hashtags: string[];
  audioTrack?: string;
  likesCount: number;
  commentsCount: number;
  viewsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoryDoc {
  _id: string;
  userId: string;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  caption?: string;
  viewsCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface StoryViewDoc {
  _id: string;
  storyId: string;
  userId: string;
  viewedAt: string;
}

export interface CommentDoc {
  _id: string;
  targetType: 'post' | 'reel';
  targetId: string;
  userId: string;
  text: string;
  parentId?: string | null;
  likesCount: number;
  createdAt: string;
}

export interface LikeDoc {
  _id: string;
  targetType: 'post' | 'reel' | 'comment';
  targetId: string;
  userId: string;
  createdAt: string;
}

export interface FollowDoc {
  _id: string;
  followerId: string;
  followingId: string;
  status: 'accepted' | 'pending';
  createdAt: string;
}

export interface SavedPostDoc {
  _id: string;
  userId: string;
  targetType: 'post' | 'reel';
  targetId: string;
  createdAt: string;
}

export interface NotificationDoc {
  _id: string;
  recipientId: string;
  senderId: string;
  type: 'like_post' | 'like_reel' | 'comment' | 'reply' | 'follow' | 'follow_request' | 'mention';
  targetId?: string;
  targetType?: 'post' | 'reel' | 'comment';
  isRead: boolean;
  createdAt: string;
}

export interface MessageDoc {
  _id: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  text: string;
  mediaUrl?: string;
  isRead: boolean;
  createdAt: string;
}

export interface ConversationDoc {
  _id: string;
  participants: string[];
  lastMessage?: string;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportDoc {
  _id: string;
  reporterId: string;
  targetType: 'post' | 'reel' | 'user' | 'comment';
  targetId: string;
  reason: string;
  details?: string;
  status: 'pending' | 'resolved' | 'dismissed';
  createdAt: string;
}

export interface BlockDoc {
  _id: string;
  blockerId: string;
  blockedId: string;
  createdAt: string;
}

export interface DatabaseState {
  users: UserDoc[];
  posts: PostDoc[];
  reels: ReelDoc[];
  stories: StoryDoc[];
  storyViews: StoryViewDoc[];
  comments: CommentDoc[];
  likes: LikeDoc[];
  follows: FollowDoc[];
  savedPosts: SavedPostDoc[];
  notifications: NotificationDoc[];
  messages: MessageDoc[];
  conversations: ConversationDoc[];
  reports: ReportDoc[];
  blocks: BlockDoc[];
}

const DB_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'bluejo_db.json');

class LocalDocumentStore {
  private data: DatabaseState = {
    users: [],
    posts: [],
    reels: [],
    stories: [],
    storyViews: [],
    comments: [],
    likes: [],
    follows: [],
    savedPosts: [],
    notifications: [],
    messages: [],
    conversations: [],
    reports: [],
    blocks: []
  };

  constructor() {
    this.init();
  }

  private init() {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    const legacyDbFile = path.join(DB_DIR, 'bharatgram_db.json');
    if (!fs.existsSync(DB_FILE) && fs.existsSync(legacyDbFile)) {
      try {
        let raw = fs.readFileSync(legacyDbFile, 'utf-8');
        raw = raw.replace(/BharatGram/g, 'BLUEJO')
                 .replace(/bharatgram\.in/g, 'bluejo.com')
                 .replace(/team@bharatgram\.in/g, 'team@bluejo.com')
                 .replace(/u_admin_bharatgram/g, 'u_admin_bluejo')
                 .replace(/"bharatgram"/g, '"bluejo"');
        const parsed = JSON.parse(raw);
        // Rename admin user username
        const adminUser = parsed.users?.find((u: any) => u.username === 'bluejo' || u._id === 'u_admin_bluejo');
        if (adminUser) {
          adminUser._id = 'u_admin_bluejo';
          adminUser.name = 'BLUEJO Team';
          adminUser.username = 'bluejo';
          adminUser.email = 'team@bluejo.com';
          adminUser.profilePhoto = '/bluejo-logo.png';
          adminUser.bio = 'Official BLUEJO Account • Connect • Create • Share. Celebrating authentic creator voices worldwide!';
          adminUser.website = 'https://bluejo.com';
        }
        this.data = parsed;
        this.save();
        return;
      } catch (err) {
        console.error('Error migrating legacy database to BLUEJO:', err);
      }
    }

    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        this.data = JSON.parse(raw);
      } catch (err) {
        console.error('Error loading local DB, initializing fresh:', err);
        this.seedInitialData();
        this.save();
      }
    } else {
      this.seedInitialData();
      this.save();
    }
  }

  public save() {
    try {
      const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
      fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (err) {
      console.error('Failed to write database file:', err);
    }
  }

  public getState(): DatabaseState {
    return this.data;
  }

  private seedInitialData() {
    const salt = bcrypt.genSaltSync(10);
    const demoPasswordHash = bcrypt.hashSync('Bharat@123', salt);
    const now = new Date();

    const seedUsers: UserDoc[] = [
      {
        _id: 'u_admin_bluejo',
        name: 'BLUEJO Team',
        username: 'bluejo',
        email: 'team@bluejo.com',
        passwordHash: demoPasswordHash,
        profilePhoto: '/bluejo-logo.png',
        bio: 'Official BLUEJO Account • Connect • Create • Share. Celebrating authentic creator voices worldwide!',
        website: 'https://bluejo.com',
        location: 'Global',
        isVerified: true,
        isPrivate: false,
        isAdmin: true,
        isSuspended: false,
        followersCount: 5,
        followingCount: 4,
        postCount: 2,
        createdAt: new Date(now.getTime() - 15 * 86400000).toISOString(),
        updatedAt: now.toISOString()
      },
      {
        _id: 'u_aarav_tech',
        name: 'Aarav Sharma',
        username: 'aarav_tech',
        email: 'aarav@techbharat.in',
        passwordHash: demoPasswordHash,
        profilePhoto: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&auto=format&fit=crop&q=80',
        bio: 'Building India’s AI future 🇮🇳 | Bengaluru Tech Scene | Flutter & Full-stack nerd | Tea > Coffee',
        website: 'https://aaravtech.in',
        location: 'Bengaluru, Karnataka',
        isVerified: true,
        isPrivate: false,
        isAdmin: false,
        isSuspended: false,
        followersCount: 4,
        followingCount: 3,
        postCount: 3,
        createdAt: new Date(now.getTime() - 10 * 86400000).toISOString(),
        updatedAt: now.toISOString()
      },
      {
        _id: 'u_priya_travels',
        name: 'Priya Iyer',
        username: 'priya_wanderlust',
        email: 'priya@incredibleindia.com',
        passwordHash: demoPasswordHash,
        profilePhoto: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=400&auto=format&fit=crop&q=80',
        bio: 'Wandering across 28 States & 8 UTs 🏔️ Exploring heritage, folk traditions & offbeat India 📸 Nikon Z6',
        website: 'https://priyatravels.in',
        location: 'Kochi, Kerala',
        isVerified: true,
        isPrivate: false,
        isAdmin: false,
        isSuspended: false,
        followersCount: 4,
        followingCount: 2,
        postCount: 2,
        createdAt: new Date(now.getTime() - 8 * 86400000).toISOString(),
        updatedAt: now.toISOString()
      },
      {
        _id: 'u_chef_kabir',
        name: 'Chef Kabir Das',
        username: 'chef_kabir',
        email: 'kabir@desizaika.in',
        passwordHash: demoPasswordHash,
        profilePhoto: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&auto=format&fit=crop&q=80',
        bio: 'From Chandni Chowk to Kolkata 🍛 Preserving regional Indian flavours and street food secrets.',
        website: 'https://desizaika.in',
        location: 'Old Delhi, India',
        isVerified: false,
        isPrivate: false,
        isAdmin: false,
        isSuspended: false,
        followersCount: 3,
        followingCount: 3,
        postCount: 2,
        createdAt: new Date(now.getTime() - 6 * 86400000).toISOString(),
        updatedAt: now.toISOString()
      },
      {
        _id: 'u_ananya_art',
        name: 'Ananya Verma',
        username: 'ananya_art',
        email: 'ananya@biharcraft.in',
        passwordHash: demoPasswordHash,
        profilePhoto: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&auto=format&fit=crop&q=80',
        bio: 'Reviving Madhubani & Warli folk art with a modern brush 🎨 Proud of our timeless heritage 🪷 #Bihar #India',
        website: 'https://ananyaart.in',
        location: 'Patna, Bihar',
        isVerified: true,
        isPrivate: false,
        isAdmin: false,
        isSuspended: false,
        followersCount: 3,
        followingCount: 2,
        postCount: 2,
        createdAt: new Date(now.getTime() - 5 * 86400000).toISOString(),
        updatedAt: now.toISOString()
      },
      {
        _id: 'u_rohit_cricket',
        name: 'Rohit Kulkarni',
        username: 'rohit_cricket',
        email: 'rohit@cricketpulse.in',
        passwordHash: demoPasswordHash,
        profilePhoto: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&auto=format&fit=crop&q=80',
        bio: 'Cricket is not just a sport, it’s an emotion in India 🏏 Analyzing every ball, cover drive & yorker!',
        website: 'https://cricketpulse.in',
        location: 'Mumbai, Maharashtra',
        isVerified: false,
        isPrivate: false,
        isAdmin: false,
        isSuspended: false,
        followersCount: 2,
        followingCount: 3,
        postCount: 1,
        createdAt: new Date(now.getTime() - 4 * 86400000).toISOString(),
        updatedAt: now.toISOString()
      }
    ];

    const seedPosts: PostDoc[] = [
      {
        _id: 'p_101',
        userId: 'u_priya_travels',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1564507592333-c60657eea523?w=1200&auto=format&fit=crop&q=80',
        caption: 'Sunrise over the Taj Mahal at dawn. Words fail to describe this marvel of heritage and love. Truly an unforgettable morning in Agra! 🇮🇳✨\n\n#India #Delhi #Heritage #IncredibleIndia #TravelIndia',
        hashtags: ['India', 'Delhi', 'Heritage', 'IncredibleIndia', 'TravelIndia'],
        location: 'Taj Mahal, Agra, Uttar Pradesh',
        likesCount: 3,
        commentsCount: 2,
        viewsCount: 24,
        visibility: 'public',
        createdAt: new Date(now.getTime() - 2 * 86400000).toISOString(),
        updatedAt: new Date(now.getTime() - 2 * 86400000).toISOString()
      },
      {
        _id: 'p_102',
        userId: 'u_aarav_tech',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=1200&auto=format&fit=crop&q=80',
        caption: 'Hacking on the new Indian open-source AI models this weekend! The developer ecosystem here in Bengaluru is moving at lightning speed. Proud to see India lead the next tech revolution 💻🚀\n\n#Technology #India #Bengaluru #Innovation',
        hashtags: ['Technology', 'India', 'Bengaluru', 'Innovation'],
        location: 'Koramangala, Bengaluru',
        likesCount: 4,
        commentsCount: 2,
        viewsCount: 35,
        visibility: 'public',
        createdAt: new Date(now.getTime() - 36 * 3600000).toISOString(),
        updatedAt: new Date(now.getTime() - 36 * 3600000).toISOString()
      },
      {
        _id: 'p_103',
        userId: 'u_ananya_art',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=1200&auto=format&fit=crop&q=80',
        caption: 'Just completed this handmade Mithila folk painting after 4 days of intricate natural pigment work. Deeply rooted in the cultural soil of Mithila, Bihar. What do you all think? 🎨🪷\n\n#Bihar #India #Art #Culture #Heritage',
        hashtags: ['Bihar', 'India', 'Art', 'Culture', 'Heritage'],
        location: 'Madhubani, Bihar',
        likesCount: 3,
        commentsCount: 1,
        viewsCount: 19,
        visibility: 'public',
        createdAt: new Date(now.getTime() - 24 * 3600000).toISOString(),
        updatedAt: new Date(now.getTime() - 24 * 3600000).toISOString()
      },
      {
        _id: 'p_104',
        userId: 'u_chef_kabir',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=1200&auto=format&fit=crop&q=80',
        caption: 'Nothing compares to slow-cooked aromatic Dum Biryani layered with saffron milk, caramelized onions, and stone-ground Indian spices. Pure bliss on a plate! 🍛❤️\n\n#DesiFood #India #Foodie #Delhi #Culture',
        hashtags: ['DesiFood', 'India', 'Foodie', 'Delhi', 'Culture'],
        location: 'Chandni Chowk, Old Delhi',
        likesCount: 2,
        commentsCount: 1,
        viewsCount: 17,
        visibility: 'public',
        createdAt: new Date(now.getTime() - 14 * 3600000).toISOString(),
        updatedAt: new Date(now.getTime() - 14 * 3600000).toISOString()
      },
      {
        _id: 'p_105',
        userId: 'u_rohit_cricket',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=1200&auto=format&fit=crop&q=80',
        caption: 'The electricity in the air when India plays at Wankhede Stadium under lights is unlike anything else in world sports! Goosebumps every single over 🏏🇮🇳\n\n#Cricket #India #Mumbai #Sports',
        hashtags: ['Cricket', 'India', 'Mumbai', 'Sports'],
        location: 'Wankhede Stadium, Mumbai',
        likesCount: 3,
        commentsCount: 1,
        viewsCount: 29,
        visibility: 'public',
        createdAt: new Date(now.getTime() - 6 * 3600000).toISOString(),
        updatedAt: new Date(now.getTime() - 6 * 3600000).toISOString()
      },
      {
        _id: 'p_106',
        userId: 'u_admin_bluejo',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?w=1200&auto=format&fit=crop&q=80',
        caption: 'Welcome to BLUEJO! 💙 A social network built for authentic creators and vibrant communities. Share your moments, reels, stories and connect with friends worldwide.\n\n#BLUEJO #Community #NextGen #Creators',
        hashtags: ['BLUEJO', 'Community', 'NextGen', 'Creators'],
        location: 'Bengaluru, India',
        likesCount: 5,
        commentsCount: 3,
        viewsCount: 48,
        visibility: 'public',
        createdAt: new Date(now.getTime() - 10 * 86400000).toISOString(),
        updatedAt: new Date(now.getTime() - 10 * 86400000).toISOString()
      }
    ];

    // High quality mobile video samples for Reels
    const seedReels: ReelDoc[] = [
      {
        _id: 'r_201',
        userId: 'u_priya_travels',
        videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        thumbnailUrl: 'https://images.unsplash.com/photo-1506461883276-594a12b11cf3?w=800&auto=format&fit=crop&q=80',
        caption: 'Majestic waterfalls and tea estates of Munnar, Kerala 🌿 Monsoon magic in God’s Own Country!\n\n#India #TravelIndia #Kerala #Nature',
        hashtags: ['India', 'TravelIndia', 'Kerala', 'Nature'],
        audioTrack: 'Original Audio - Priya Iyer • Kerala Serenade',
        likesCount: 3,
        commentsCount: 1,
        viewsCount: 42,
        createdAt: new Date(now.getTime() - 30 * 3600000).toISOString(),
        updatedAt: new Date(now.getTime() - 30 * 3600000).toISOString()
      },
      {
        _id: 'r_202',
        userId: 'u_aarav_tech',
        videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4',
        thumbnailUrl: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80',
        caption: 'Day in the life of a software engineer in Bengaluru ☕💻 Standups, deploying code, filter coffee & startup vibes!\n\n#Technology #Bengaluru #Coding #India',
        hashtags: ['Technology', 'Bengaluru', 'Coding', 'India'],
        audioTrack: 'Original Audio - Aarav • Bengaluru Beats',
        likesCount: 4,
        commentsCount: 2,
        viewsCount: 58,
        createdAt: new Date(now.getTime() - 18 * 3600000).toISOString(),
        updatedAt: new Date(now.getTime() - 18 * 3600000).toISOString()
      },
      {
        _id: 'r_203',
        userId: 'u_chef_kabir',
        videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
        thumbnailUrl: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop&q=80',
        caption: 'Crispy golden Jalebis getting fried fresh in desi ghee at 6 AM in Chandni Chowk 🍯 Incredible sizzle!\n\n#DesiFood #Delhi #StreetFood #India',
        hashtags: ['DesiFood', 'Delhi', 'StreetFood', 'India'],
        audioTrack: 'Traditional Shehnai & Sitar Fusion',
        likesCount: 2,
        commentsCount: 1,
        viewsCount: 31,
        createdAt: new Date(now.getTime() - 8 * 3600000).toISOString(),
        updatedAt: new Date(now.getTime() - 8 * 3600000).toISOString()
      }
    ];

    // Stories (valid within 24h)
    const seedStories: StoryDoc[] = [
      {
        _id: 's_301',
        userId: 'u_aarav_tech',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&auto=format&fit=crop&q=80',
        caption: 'Late night hackathon sprint in Indiranagar! 💻⚡',
        viewsCount: 5,
        createdAt: new Date(now.getTime() - 4 * 3600000).toISOString(),
        expiresAt: new Date(now.getTime() + 20 * 3600000).toISOString()
      },
      {
        _id: 's_302',
        userId: 'u_priya_travels',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&auto=format&fit=crop&q=80',
        caption: 'Catching the sunset at Varkala Cliff 🌅 Beautiful coastal breeze',
        viewsCount: 7,
        createdAt: new Date(now.getTime() - 6 * 3600000).toISOString(),
        expiresAt: new Date(now.getTime() + 18 * 3600000).toISOString()
      },
      {
        _id: 's_303',
        userId: 'u_ananya_art',
        mediaType: 'image',
        mediaUrl: 'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=800&auto=format&fit=crop&q=80',
        caption: 'Mixing natural turmeric and indigo colors today 🎨',
        viewsCount: 4,
        createdAt: new Date(now.getTime() - 2 * 3600000).toISOString(),
        expiresAt: new Date(now.getTime() + 22 * 3600000).toISOString()
      },
      {
        _id: 's_304',
        userId: 'u_admin_bluejo',
        mediaType: 'image',
        mediaUrl: '/bluejo-logo.png',
        caption: 'Explore trending creators today on BLUEJO',
        viewsCount: 12,
        createdAt: new Date(now.getTime() - 1 * 3600000).toISOString(),
        expiresAt: new Date(now.getTime() + 23 * 3600000).toISOString()
      }
    ];

    const seedComments: CommentDoc[] = [
      {
        _id: 'c_401',
        targetType: 'post',
        targetId: 'p_101',
        userId: 'u_aarav_tech',
        text: 'Breathtaking capture Priya! The morning light hitting the marble dome is pure poetry.',
        likesCount: 1,
        createdAt: new Date(now.getTime() - 40 * 3600000).toISOString()
      },
      {
        _id: 'c_402',
        targetType: 'post',
        targetId: 'p_101',
        userId: 'u_ananya_art',
        text: 'Agra in early winter is so peaceful. Such vibrant colours!',
        likesCount: 0,
        createdAt: new Date(now.getTime() - 30 * 3600000).toISOString()
      },
      {
        _id: 'c_403',
        targetType: 'post',
        targetId: 'p_102',
        userId: 'u_rohit_cricket',
        text: 'Tech talent in India is unmatched right now bhai! Keep building.',
        likesCount: 1,
        createdAt: new Date(now.getTime() - 20 * 3600000).toISOString()
      },
      {
        _id: 'c_404',
        targetType: 'post',
        targetId: 'p_103',
        userId: 'u_priya_travels',
        text: 'The geometric symmetry of your Mithila art is stunning Ananya!',
        likesCount: 0,
        createdAt: new Date(now.getTime() - 15 * 3600000).toISOString()
      },
      {
        _id: 'c_405',
        targetType: 'reel',
        targetId: 'r_201',
        userId: 'u_chef_kabir',
        text: 'Kerala monsoon is legendary! Hope you tried the hot Kerala parotta and tea there!',
        likesCount: 1,
        createdAt: new Date(now.getTime() - 10 * 3600000).toISOString()
      }
    ];

    const seedLikes: LikeDoc[] = [
      { _id: 'l_501', targetType: 'post', targetId: 'p_101', userId: 'u_aarav_tech', createdAt: now.toISOString() },
      { _id: 'l_502', targetType: 'post', targetId: 'p_101', userId: 'u_ananya_art', createdAt: now.toISOString() },
      { _id: 'l_503', targetType: 'post', targetId: 'p_101', userId: 'u_admin_bluejo', createdAt: now.toISOString() },
      { _id: 'l_504', targetType: 'post', targetId: 'p_102', userId: 'u_priya_travels', createdAt: now.toISOString() },
      { _id: 'l_505', targetType: 'post', targetId: 'p_102', userId: 'u_rohit_cricket', createdAt: now.toISOString() },
      { _id: 'l_506', targetType: 'post', targetId: 'p_102', userId: 'u_admin_bluejo', createdAt: now.toISOString() },
      { _id: 'l_507', targetType: 'post', targetId: 'p_102', userId: 'u_ananya_art', createdAt: now.toISOString() },
      { _id: 'l_508', targetType: 'post', targetId: 'p_103', userId: 'u_aarav_tech', createdAt: now.toISOString() },
      { _id: 'l_509', targetType: 'post', targetId: 'p_103', userId: 'u_priya_travels', createdAt: now.toISOString() },
      { _id: 'l_510', targetType: 'post', targetId: 'p_103', userId: 'u_admin_bluejo', createdAt: now.toISOString() },
      { _id: 'l_511', targetType: 'post', targetId: 'p_106', userId: 'u_aarav_tech', createdAt: now.toISOString() },
      { _id: 'l_512', targetType: 'post', targetId: 'p_106', userId: 'u_priya_travels', createdAt: now.toISOString() },
      { _id: 'l_513', targetType: 'post', targetId: 'p_106', userId: 'u_ananya_art', createdAt: now.toISOString() },
      { _id: 'l_514', targetType: 'post', targetId: 'p_106', userId: 'u_chef_kabir', createdAt: now.toISOString() },
      { _id: 'l_515', targetType: 'post', targetId: 'p_106', userId: 'u_rohit_cricket', createdAt: now.toISOString() },
      { _id: 'l_516', targetType: 'reel', targetId: 'r_201', userId: 'u_aarav_tech', createdAt: now.toISOString() },
      { _id: 'l_517', targetType: 'reel', targetId: 'r_201', userId: 'u_chef_kabir', createdAt: now.toISOString() },
      { _id: 'l_518', targetType: 'reel', targetId: 'r_201', userId: 'u_admin_bluejo', createdAt: now.toISOString() },
      { _id: 'l_519', targetType: 'reel', targetId: 'r_202', userId: 'u_priya_travels', createdAt: now.toISOString() },
      { _id: 'l_520', targetType: 'reel', targetId: 'r_202', userId: 'u_rohit_cricket', createdAt: now.toISOString() },
      { _id: 'l_521', targetType: 'reel', targetId: 'r_202', userId: 'u_ananya_art', createdAt: now.toISOString() },
      { _id: 'l_522', targetType: 'reel', targetId: 'r_202', userId: 'u_admin_bluejo', createdAt: now.toISOString() }
    ];

    const seedFollows: FollowDoc[] = [
      { _id: 'f_601', followerId: 'u_aarav_tech', followingId: 'u_admin_bluejo', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_602', followerId: 'u_priya_travels', followingId: 'u_admin_bluejo', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_603', followerId: 'u_chef_kabir', followingId: 'u_admin_bluejo', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_604', followerId: 'u_ananya_art', followingId: 'u_admin_bluejo', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_605', followerId: 'u_rohit_cricket', followingId: 'u_admin_bluejo', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_606', followerId: 'u_admin_bluejo', followingId: 'u_aarav_tech', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_607', followerId: 'u_admin_bluejo', followingId: 'u_priya_travels', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_608', followerId: 'u_admin_bluejo', followingId: 'u_ananya_art', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_609', followerId: 'u_admin_bluejo', followingId: 'u_chef_kabir', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_610', followerId: 'u_aarav_tech', followingId: 'u_priya_travels', status: 'accepted', createdAt: now.toISOString() },
      { _id: 'f_611', followerId: 'u_priya_travels', followingId: 'u_aarav_tech', status: 'accepted', createdAt: now.toISOString() }
    ];

    const seedConversations: ConversationDoc[] = [
      {
        _id: 'conv_701',
        participants: ['u_aarav_tech', 'u_admin_bluejo'],
        lastMessage: 'Welcome Aarav to BLUEJO! Great to have you on board.',
        lastMessageAt: new Date(now.getTime() - 2 * 3600000).toISOString(),
        createdAt: new Date(now.getTime() - 5 * 86400000).toISOString(),
        updatedAt: new Date(now.getTime() - 2 * 3600000).toISOString()
      }
    ];

    const seedMessages: MessageDoc[] = [
      {
        _id: 'm_801',
        conversationId: 'conv_701',
        senderId: 'u_admin_bluejo',
        receiverId: 'u_aarav_tech',
        text: 'Welcome Aarav to BLUEJO! Great to have you on board.',
        isRead: true,
        createdAt: new Date(now.getTime() - 2 * 3600000).toISOString()
      }
    ];

    const seedNotifications: NotificationDoc[] = [
      {
        _id: 'n_901',
        recipientId: 'u_priya_travels',
        senderId: 'u_aarav_tech',
        type: 'like_post',
        targetId: 'p_101',
        targetType: 'post',
        isRead: false,
        createdAt: new Date(now.getTime() - 3 * 3600000).toISOString()
      },
      {
        _id: 'n_902',
        recipientId: 'u_priya_travels',
        senderId: 'u_aarav_tech',
        type: 'comment',
        targetId: 'p_101',
        targetType: 'post',
        isRead: false,
        createdAt: new Date(now.getTime() - 2 * 3600000).toISOString()
      },
      {
        _id: 'n_903',
        recipientId: 'u_aarav_tech',
        senderId: 'u_admin_bluejo',
        type: 'follow',
        isRead: true,
        createdAt: new Date(now.getTime() - 4 * 86400000).toISOString()
      }
    ];

    this.data = {
      users: seedUsers,
      posts: seedPosts,
      reels: seedReels,
      stories: seedStories,
      storyViews: [],
      comments: seedComments,
      likes: seedLikes,
      follows: seedFollows,
      savedPosts: [],
      notifications: seedNotifications,
      messages: seedMessages,
      conversations: seedConversations,
      reports: [],
      blocks: []
    };
  }
}

export const dbStore = new LocalDocumentStore();

// Optional MongoDB Atlas connection logic
let isMongoConnected = false;
export async function initMongoDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri || uri.trim() === '') {
    console.log('[Database] MONGODB_URI not provided. Operating on persistent local document store.');
    return;
  }
  try {
    console.log('[Database] Connecting to MongoDB Atlas...');
    await mongoose.connect(uri);
    isMongoConnected = true;
    console.log('[Database] Successfully connected to MongoDB Atlas!');
  } catch (err) {
    console.warn('[Database] MongoDB Atlas connection failed. Falling back gracefully to persistent document store:', err);
  }
}

export function isUsingMongoDB() {
  return isMongoConnected;
}
