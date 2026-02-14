# Detector

A Chrome extension that detects and downloads videos, audio, and other media from websites. It works on 170+ sites including YouTube, Instagram, Twitter/X, TikTok, Netflix, and many more. It also has a generic mode that tries to grab media from any site not on the list.

Please respect copyright laws and terms of service when using this.

## What it does

- Finds video and audio on a page automatically (no need to paste URLs)
- Downloads HLS (M3U8) and DASH (MPD) streams segment by segment
- Merges separate video and audio tracks using built-in WASM (libav)
- Lets you pick quality (360p, 720p, 1080p, etc.)
- Handles large files up to 20GB using OPFS (disk-backed storage)
- Downloads 4 segments at once with automatic retry
- Shows download progress, speed, and ETA in real time

## Supported sites

**Video:** YouTube, Vimeo, Dailymotion, Rutube, Rumble, Bitchute, Odysee, PeerTube, Streamable, and more

**Social media:** Facebook, Instagram, Twitter/X, TikTok, Reddit, Snapchat, Pinterest, LinkedIn, Tumblr, VK, Bluesky, and more

**Live streaming:** Twitch, Kick, DLive, Trovo, and more

**Music/Audio:** SoundCloud, Spotify, Deezer, Bandcamp, Audiomack, Mixcloud, and more

**News:** CNN, BBC, Fox News, Reuters, Bloomberg, Al Jazeera, and more

**Education:** Coursera, Udemy, Khan Academy, TED, and more

**Asian platforms:** Bilibili, Niconico, Hotstar, Zee5, and more

**Embed players:** Brightcove, JW Player, Kaltura, Wistia, and more

If a site isn't on the list, the generic extractor will still try to find media on the page.

## Installation

1. Download or clone this repo
2. Open Chrome and go to `chrome://extensions`
3. Turn on "Developer mode" (toggle in the top right)
4. Click "Load unpacked" and select the `Detector` folder
5. Pin the extension to your toolbar so you can access it easily

## How to use

1. Go to a website that has video or audio
2. Click the Detector icon in your toolbar
3. Pick the quality you want and click download

That's it. The extension detects media on the page automatically.

## Troubleshooting

**The extension icon doesn't show anything / no media detected**

- Make sure the video has actually started playing on the page. Some sites don't load media until you hit play.
- Try refreshing the page and waiting a few seconds before clicking the icon.
- Check that the extension has permissions for the site. Go to `chrome://extensions`, click "Details" on Detector, and make sure "Site access" is set to "On all sites" or at least includes the site you're on.

**Download starts but fails or gets stuck**

- Some sites use DRM protection that blocks downloading. There's not much you can do about that.
- If it's a long video, give it time. Large HLS/DASH streams have hundreds of segments.
- Try closing other tabs to free up memory. Merging video+audio in the browser uses RAM.
- Check your disk space. Large downloads need enough free space for both the segments and the final merged file.

**The downloaded video has no audio (or no video)**

- This usually means the merging step failed. Try the download again.
- If it keeps happening, try picking a lower quality. The higher-quality streams are sometimes in separate video/audio tracks that need merging.
  **Video quality is low / doesn't match what I selected**

- Some sites only serve certain qualities based on your account, region, or whether you're logged in.
- Make sure you're selecting the right option in the quality picker.

**Extension crashed or Chrome shows an error**

- Go to `chrome://extensions`, disable and re-enable Detector.
- If that doesn't work, remove it and load it again using the installation steps above.
- Check the console for errors: right-click the extension icon > "Inspect popup" or go to `chrome://extensions` > Detector > "Inspect views: service worker".

**"Download failed - network error"**

- Check your internet connection.
- Some sites block requests from extensions. Try again or try a different quality.
- If you're behind a VPN or proxy, try turning it off temporarily.

**The extension doesn't work on a specific site**

- Not every site is supported, even with the generic extractor.
- Some sites frequently change their structure, which can break the extractor. You can open an issue on GitHub if you find a broken site.

**Downloads are very slow**

- The speed depends on the source site's servers, not the extension.
- Try a lower quality if available.
- Check if other downloads or tabs are using your bandwidth.

## License

[Unlicense](../LICENSE) - public domain. Do whatever you want with it.
