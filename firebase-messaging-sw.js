// מקבל התראות כשהאתר סגור
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBmBLkkzcMl7Y5uzl5hbg-eiFQ5p2ltLLQ",
  authDomain: "bukimanagement-c128b.firebaseapp.com",
  projectId: "bukimanagement-c128b",
  storageBucket: "bukimanagement-c128b.firebasestorage.app",
  messagingSenderId: "627894098833",
  appId: "1:627894098833:web:950d3da569c1fa03285830"
});
firebase.messaging();

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.FCM_MSG && e.notification.data.FCM_MSG.fcmOptions && e.notification.data.FCM_MSG.fcmOptions.link) || self.registration.scope;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return clients.openWindow(url);
  }));
});
