import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.velocityblocks.game',
  appName: 'Velocity Blocks',
  webDir: 'dist',
  backgroundColor: '#0b1020',
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'never',
  },
};

export default config;
