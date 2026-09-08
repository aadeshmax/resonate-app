import { AppRegistry } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import App from './App';
import PlaybackService from './service';

AppRegistry.registerComponent('main', () => App);
TrackPlayer.registerPlaybackService(() => PlaybackService);