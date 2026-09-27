import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import { SocketProvider } from './context/SocketContext';
import { Header } from './components/common/Header';
import { Sidebar } from './components/common/Sidebar';
import { BottomNav } from './components/common/BottomNav';
import { Logo } from './components/common/Logo';

// Views
import { FeedView } from './components/views/FeedView';
import { ExploreView } from './components/views/ExploreView';
import { ReelsFeed } from './components/reels/ReelsFeed';
import { ChatView } from './components/views/ChatView';
import { NotificationsView } from './components/views/NotificationsView';
import { ProfileView } from './components/views/ProfileView';
import { HashtagView } from './components/views/HashtagView';
import { SettingsView } from './components/views/SettingsView';
import { AdminDashboard } from './components/views/AdminDashboard';

// Modals
import { CreatePostModal } from './components/modals/CreatePostModal';
import { CreateStoryModal } from './components/modals/CreateStoryModal';
import { StoryViewer } from './components/feed/StoryViewer';
import { CommentDrawer } from './components/modals/CommentDrawer';
import { ShareModal } from './components/modals/ShareModal';
import { ReportModal } from './components/modals/ReportModal';
import { AuthModal } from './components/modals/AuthModal';
import { EditProfileModal } from './components/modals/EditProfileModal';
import { SinglePostModal } from './components/modals/SinglePostModal';
import { Post, Reel } from './types';

function getInitialRoute(): { view: string; params: any } {
  if (typeof window === 'undefined') return { view: 'feed', params: {} };
  const pathname = window.location.pathname;
  if (pathname.startsWith('/profile/')) {
    const rawUser = pathname.replace('/profile/', '').split('/')[0].trim();
    if (rawUser) {
      return { view: 'profile', params: { username: decodeURIComponent(rawUser) } };
    }
  } else if (pathname === '/profile') {
    return { view: 'profile', params: {} };
  } else if (pathname === '/explore') {
    return { view: 'explore', params: {} };
  } else if (pathname === '/reels') {
    return { view: 'reels', params: {} };
  } else if (pathname === '/messages') {
    return { view: 'messages', params: {} };
  } else if (pathname === '/notifications') {
    return { view: 'notifications', params: {} };
  } else if (pathname === '/settings') {
    return { view: 'settings', params: {} };
  }
  return { view: 'feed', params: {} };
}

function BluejoApp() {
  const { user, logout, isLoading } = useAuth();
  const { t } = useLanguage();

  // Navigation State initialized from URL
  const [initialRoute] = useState(() => getInitialRoute());
  const [currentView, setCurrentView] = useState<string>(initialRoute.view);
  const [viewParams, setViewParams] = useState<any>(initialRoute.params);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Modal States
  const [showCreatePost, setShowCreatePost] = useState(false);
  const [showCreateStory, setShowCreateStory] = useState(false);
  const [activeStoryIndex, setActiveStoryIndex] = useState<number | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ target: Post | Reel; targetType: 'post' | 'reel' } | null>(null);
  const [shareTarget, setShareTarget] = useState<{ target: Post | Reel; targetType: 'post' | 'reel' } | null>(null);
  const [reportTarget, setReportTarget] = useState<{ targetId: string; targetType: 'post' | 'reel' | 'user' | 'comment' } | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showEditProfileModal, setShowEditProfileModal] = useState(false);
  const [viewingPostId, setViewingPostId] = useState<string | null>(null);

  // Browser back/forward button support
  React.useEffect(() => {
    const handlePopState = () => {
      const route = getInitialRoute();
      setCurrentView(route.view);
      setViewParams(route.params);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Sync /profile with user's own username once user is loaded
  React.useEffect(() => {
    if (currentView === 'profile' && !viewParams.username && user?.username) {
      setViewParams((prev: any) => ({ ...prev, username: user.username }));
      const path = `/profile/${encodeURIComponent(user.username)}`;
      if (window.location.pathname !== path) {
        window.history.replaceState({ view: 'profile', params: { username: user.username } }, '', path);
      }
    }
  }, [currentView, viewParams.username, user?.username]);

  const handleNavigate = (view: string, params?: any) => {
    // If route requires auth and not logged in, show auth modal
    if (['messages', 'notifications', 'settings', 'admin'].includes(view) && !user) {
      setShowAuthModal(true);
      return;
    }

    let targetParams = params || {};
    if (view === 'profile' && !targetParams.username && user?.username) {
      targetParams = { ...targetParams, username: user.username };
    }

    setCurrentView(view);
    setViewParams(targetParams);

    // Sync browser URL
    let targetPath = '/';
    if (view === 'profile') {
      const un = targetParams.username || user?.username;
      targetPath = un ? `/profile/${encodeURIComponent(un)}` : '/profile';
    } else if (view === 'explore') {
      targetPath = '/explore';
    } else if (view === 'reels') {
      targetPath = '/reels';
    } else if (view === 'messages') {
      targetPath = '/messages';
    } else if (view === 'notifications') {
      targetPath = '/notifications';
    } else if (view === 'settings') {
      targetPath = '/settings';
    }

    if (window.location.pathname !== targetPath) {
      window.history.pushState({ view, params: targetParams }, '', targetPath);
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleTriggerRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  if (isLoading) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white select-none">
        <div className="flex flex-col items-center scale-110">
          <Logo size="xl" showText={true} showTagline={true} />
        </div>
        <div className="mt-8 flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-blue-600 animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2.5 h-2.5 rounded-full bg-indigo-600 animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
        <div className="absolute bottom-6 text-xs text-slate-400 font-semibold tracking-wider uppercase">
          BLUEJO • Connect • Create • Share
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50/60 flex flex-col text-slate-900 font-sans antialiased">
      {/* Top Sticky Header */}
      <Header
        onOpenCreate={() => {
          if (!user) setShowAuthModal(true);
          else setShowCreatePost(true);
        }}
        onOpenAuth={() => setShowAuthModal(true)}
        onNavigate={handleNavigate}
        currentView={currentView}
      />

      {/* Main Layout Area */}
      <div className="flex-1 flex max-w-7xl w-full mx-auto pb-16 md:pb-6">
        {/* Desktop Left Sidebar */}
        <Sidebar
          currentView={currentView}
          onNavigate={handleNavigate}
          onOpenCreate={() => {
            if (!user) setShowAuthModal(true);
            else setShowCreatePost(true);
          }}
          onOpenAuth={() => setShowAuthModal(true)}
        />

        {/* Dynamic Center View Container */}
        <main className="flex-1 min-w-0">
          {currentView === 'feed' && (
            <FeedView
              onOpenStory={(groupIndex) => setActiveStoryIndex(groupIndex)}
              onAddStory={() => {
                if (!user) setShowAuthModal(true);
                else setShowCreateStory(true);
              }}
              onOpenComments={(post) => setCommentTarget({ target: post, targetType: 'post' })}
              onOpenShare={(post) => setShareTarget({ target: post, targetType: 'post' })}
              onOpenReport={(targetId, targetType) => setReportTarget({ targetId, targetType })}
              onNavigateToUser={(username) => handleNavigate('profile', { username })}
              onNavigateToHashtag={(tag) => handleNavigate('hashtag', { tag })}
              refreshTrigger={refreshTrigger}
            />
          )}

          {currentView === 'explore' && (
            <ExploreView
              onNavigateToPost={(postId) => setViewingPostId(postId)}
              onNavigateToUser={(username) => handleNavigate('profile', { username })}
              onNavigateToHashtag={(tag) => handleNavigate('hashtag', { tag })}
            />
          )}

          {currentView === 'reels' && (
            <ReelsFeed
              onOpenComments={(reel) => setCommentTarget({ target: reel, targetType: 'reel' })}
              onOpenShare={(reel) => setShareTarget({ target: reel, targetType: 'reel' })}
              onNavigateToUser={(username) => handleNavigate('profile', { username })}
              onNavigateToHashtag={(tag) => handleNavigate('hashtag', { tag })}
            />
          )}

          {currentView === 'messages' && (
            <ChatView
              initialUserId={viewParams.userId}
              onNavigateToUser={(username) => handleNavigate('profile', { username })}
            />
          )}

          {currentView === 'notifications' && (
            <NotificationsView
              onNavigateToUser={(username) => handleNavigate('profile', { username })}
              onNavigateToPost={(postId) => setViewingPostId(postId)}
            />
          )}

          {currentView === 'profile' && (
            <ProfileView
              key={`${viewParams.username || user?.username || 'me'}_${refreshTrigger}`}
              username={viewParams.username || user?.username || 'aarav_tech'}
              initialTab={viewParams.tab || 'posts'}
              onNavigateToPost={(postId) => setViewingPostId(postId)}
              onNavigateToUser={(username) => handleNavigate('profile', { username })}
              onStartChat={(targetUserId) => handleNavigate('messages', { userId: targetUserId })}
              onOpenSettings={() => handleNavigate('settings')}
              onOpenEditProfile={() => setShowEditProfileModal(true)}
            />
          )}

          {currentView === 'saved' && (
            <ProfileView
              key={`saved_${user?.username || 'me'}_${refreshTrigger}`}
              username={user?.username || 'aarav_tech'}
              initialTab="saved"
              onNavigateToPost={(postId) => setViewingPostId(postId)}
              onNavigateToUser={(username) => handleNavigate('profile', { username })}
              onStartChat={(targetUserId) => handleNavigate('messages', { userId: targetUserId })}
              onOpenSettings={() => handleNavigate('settings')}
              onOpenEditProfile={() => setShowEditProfileModal(true)}
            />
          )}

          {currentView === 'hashtag' && (
            <HashtagView
              hashtag={viewParams.tag || 'IncredibleIndia'}
              onBack={() => handleNavigate('explore')}
              onNavigateToPost={(postId) => setViewingPostId(postId)}
            />
          )}

          {currentView === 'settings' && (
            <SettingsView
              onLogout={() => {
                logout();
                handleNavigate('feed');
              }}
            />
          )}

          {currentView === 'admin' && <AdminDashboard />}
        </main>
      </div>

      {/* Mobile Bottom Navigation */}
      <BottomNav
        currentView={currentView}
        onNavigate={handleNavigate}
        onOpenCreate={() => {
          if (!user) setShowAuthModal(true);
          else setShowCreatePost(true);
        }}
        onOpenAuth={() => setShowAuthModal(true)}
      />

      {/* --- MODALS --- */}

      {/* Create Post / Reel Modal */}
      {showCreatePost && (
        <CreatePostModal
          onClose={() => setShowCreatePost(false)}
          onPostCreated={handleTriggerRefresh}
        />
      )}

      {/* Create Story Modal */}
      {showCreateStory && (
        <CreateStoryModal
          onClose={() => setShowCreateStory(false)}
          onStoryCreated={handleTriggerRefresh}
        />
      )}

      {/* Fullscreen Story Viewer */}
      {activeStoryIndex !== null && (
        <StoryViewer
          initialGroupIndex={activeStoryIndex}
          onClose={() => setActiveStoryIndex(null)}
          onStoryDeleted={handleTriggerRefresh}
        />
      )}

      {/* Comment Drawer for Posts & Reels */}
      {commentTarget && (
        <CommentDrawer
          target={commentTarget.target}
          targetType={commentTarget.targetType}
          onClose={() => setCommentTarget(null)}
          onCommentsUpdated={handleTriggerRefresh}
          onNavigateToUser={(username) => {
            setCommentTarget(null);
            handleNavigate('profile', { username });
          }}
        />
      )}

      {/* Share Modal */}
      {shareTarget && (
        <ShareModal
          target={shareTarget.target}
          targetType={shareTarget.targetType}
          onClose={() => setShareTarget(null)}
        />
      )}

      {/* Report Modal */}
      {reportTarget && (
        <ReportModal
          targetId={reportTarget.targetId}
          targetType={reportTarget.targetType}
          onClose={() => setReportTarget(null)}
        />
      )}

      {/* Auth Modal (Login & Signup) */}
      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          initialMode="login"
        />
      )}

      {/* Edit Profile Modal */}
      {showEditProfileModal && (
        <EditProfileModal
          onClose={() => setShowEditProfileModal(false)}
          onProfileUpdated={(newUsername) => {
            handleTriggerRefresh();
            if (newUsername) {
              setViewParams((prev: any) => ({ ...prev, username: newUsername }));
              const targetPath = `/profile/${encodeURIComponent(newUsername)}`;
              window.history.replaceState({ view: 'profile', params: { username: newUsername } }, '', targetPath);
            }
          }}
        />
      )}

      {/* Single Post Modal (when clicking from explore / hashtag / notification) */}
      {viewingPostId && (
        <SinglePostModal
          postId={viewingPostId}
          onClose={() => setViewingPostId(null)}
          onOpenComments={(post) => setCommentTarget({ target: post, targetType: 'post' })}
          onOpenShare={(post) => setShareTarget({ target: post, targetType: 'post' })}
          onOpenReport={(targetId, targetType) => setReportTarget({ targetId, targetType })}
          onNavigateToUser={(username) => handleNavigate('profile', { username })}
          onNavigateToHashtag={(tag) => handleNavigate('hashtag', { tag })}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <SocketProvider>
          <BluejoApp />
        </SocketProvider>
      </AuthProvider>
    </LanguageProvider>
  );
}
