export interface User {
  _id: string;
  name: string;
  username: string;
  email: string;
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
  reelCount?: number;
  creatorRank?: number;
  createdAt: string;
  updatedAt: string;
  dob?: string;
  isEmailVerified?: boolean;
  isPhoneVerified?: boolean;
  firebaseUid?: string;
  phoneNumber?: string;
  isFollowing?: boolean;
  isFollowPending?: boolean;
  isBlockedByMe?: boolean;
  isMe?: boolean;
}

export interface Post {
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
  author: User;
  isLikedByMe: boolean;
  isSavedByMe: boolean;
  commentsPreview?: Comment[];
}

export interface Reel {
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
  author: User;
  isLikedByMe: boolean;
  isSavedByMe: boolean;
  isFollowingAuthor: boolean;
}

export interface Story {
  _id: string;
  userId: string;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  caption?: string;
  viewsCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface StoryGroup {
  userId: string;
  author: User;
  hasUnviewed: boolean;
  stories: Story[];
}

export interface Comment {
  _id: string;
  targetType: 'post' | 'reel';
  targetId: string;
  userId: string;
  text: string;
  parentId?: string | null;
  likesCount: number;
  createdAt: string;
  author?: User;
  isLikedByMe?: boolean;
}

export interface NotificationItem {
  _id: string;
  recipientId: string;
  senderId: string;
  type: 'like_post' | 'like_reel' | 'comment' | 'reply' | 'follow' | 'follow_request' | 'mention';
  targetId?: string;
  targetType?: 'post' | 'reel' | 'comment';
  isRead: boolean;
  createdAt: string;
  sender?: User;
}

export interface Message {
  _id: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  text: string;
  mediaUrl?: string;
  isRead: boolean;
  createdAt: string;
}

export interface Conversation {
  _id: string;
  participants: string[];
  lastMessage?: string;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
  otherUser?: User;
  isOnline?: boolean;
  unreadCount?: number;
}

export interface ReportItem {
  _id: string;
  reporterId: string;
  targetType: 'post' | 'reel' | 'user' | 'comment';
  targetId: string;
  reason: string;
  details?: string;
  status: 'pending' | 'resolved' | 'dismissed';
  createdAt: string;
  reporter?: User;
  targetDetails?: any;
}
