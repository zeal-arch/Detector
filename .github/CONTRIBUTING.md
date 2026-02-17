# Contributing to Detector

Hey! Thanks for wanting to contribute. This project is honestly just me (and hopefully you) trying to make downloading videos less painful.

## Ways to Contribute

- **Report bugs** - Something broken? Let me know
- **Suggest features** - Got ideas? I'm all ears
- **Add support for new websites** - This is the big one. Always need more site extractors
- **Fix bugs** - PRs are always welcome
- **Improve code** - If you see something that could be better, go for it

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/Detector.git
   cd Detector
   ```
3. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Setup

### For Chrome/Chromium Browsers

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked" and select the Detector directory
4. Make your changes and click the reload icon to test

### For Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select the `manifest.json` file from the Detector directory
4. Make your changes and click "Reload" to test

## Adding Support for a New Website

This is where most of the value is. Here's the real process:

1. Open the website in your browser with DevTools open (F12)
2. Watch the Network tab while the video loads - look for .m3u8, .mpd, or .mp4 files
3. Check what other video downloader extensions do (yeah, learn from others)
4. Google "[website name] video download API" - sometimes you find gold
5. Look at similar extractors in the `extractors/` folder
6. Copy one that's close and modify it for your site
7. Add your extractor to `extractors/site-map.js`
8. Test it a bunch until it works

Be honest: you'll probably use ChatGPT/Claude or StackOverflow. That's fine, everyone does. Just make sure you understand the code you're submitting.

## Code Style

Just try to match what's already there. I'm not super strict about this. As long as it:

- Doesn't look like garbage
- Has some comments so I can understand it
- Actually works

We're good.

## Testing Your Changes

Before you submit a PR:

1. Test it in Chrome AND Firefox (they handle things differently)
2. Make sure you didn't break anything else
3. Try it on a few different videos/pages from that site
4. Check the console for errors (F12 > Console)
5. Test what happens when there's no video on the page

Basically, actually use it. Don't just test once and assume it works.

## Submitting a Pull Request

1. **Commit your changes** with clear, descriptive commit messages:

   ```bash
   git add .
   git commit -m "Add support for ExampleSite.com"
   ```

2. **Push to your fork**:

   ```bash
   git push origin feature/your-feature-name
   ```

3. **Open a pull request** on GitHub with:
   - Clear description of changes
   - Link to any related issues
   - Screenshots/videos if applicable
   - List of tested browsers and platforms

## Pull Request Guidelines

- Keep pull requests focused on a single feature or fix
- Update documentation if you're changing functionality
- Make sure your code follows the project's style
- Respond to review feedback promptly
- Be patient - maintainers review PRs as time allows

## Reporting Bugs

When reporting bugs, please include:

- Browser name and version
- Extension version
- Website where the issue occurs
- Steps to reproduce the issue
- Expected vs actual behavior
- Browser console errors (if any)
- Screenshots or videos (if helpful)

## Feature Requests

When suggesting features:

- Check if a similar feature was already requested
- Explain the use case and benefits
- Describe how you envision it working
- Be open to discussion and feedback

## Legal Notice

By contributing to Detector, you agree that your contributions will be licensed under the same license as the project (see LICENSE file).

## Questions?

Just open an issue and ask. I'll try to help when I can.

## Thanks!

Seriously, any help is appreciated. Video downloaders are weirdly difficult, and websites keep changing their stuff.
