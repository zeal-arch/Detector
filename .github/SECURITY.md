# Security Policy

## Let's Be Real

This is a browser extension that downloads videos from websites, including handling DRM-protected content. Let me be completely transparent about how it works and what you should know.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | Yes, I'll fix bugs |
| < 1.0   | Please update      |

## Found a Security Issue?

If you find a real security vulnerability (data leaks, XSS, code injection, etc.), please report it privately:

- Use GitHub's private security advisory feature
- Or open an issue but be vague until I contact you

Include what the issue is, how to reproduce it, and what browser/OS you're using. I'll fix legitimate security issues ASAP.

## What This Extension Actually Does

Being completely honest:

**It does:**

- Monitors network requests to find video/photo files
- Can decrypt DRM-protected streams (Widevine L3)
- Processes everything locally in your browser
- Can communicate with remote CDM servers if you configure that

**It doesn't:**

- Collect your data (I literally have no backend to send data to)
- Track what you download
- Include any analytics or telemetry
- Phone home to anyone

The code is open source. You can verify all of this yourself.

## About the DRM Stuff

Yeah, this extension can handle DRM. Let's address it directly:

- Some streaming sites encrypt their videos with Widevine DRM
- This extension can decrypt that for downloads
- This is a gray area legally depending on where you live
- Streaming services (Netflix, Disney+, etc.) can and will ban your account if they detect this
- **Use at your own risk**

I built this because I wanted to download content I paid for. What you use it for is your responsibility. Don't be stupid about it - respect copyright, don't pirate content, and understand the risks.

Basically: use it responsibly. Download your own purchased content, educational material, or content you have rights to. Don't be that person who ruins it for everyone.

## Privacy

- I don't collect your data (there's literally nowhere for it to go)
- No analytics or tracking
- Everything happens locally on your machine
- The extension is open source - check the code yourself

Obviously the websites you download from can see you're accessing their files, and your ISP can see your traffic like they always can. But I'm not watching or storing anything.

## Security Best Practices

- Only install from this official GitHub repo (not random forks)
- Keep it updated
- Read the code if you're paranoid (it's open source for this reason)
- Don't use it for illegal stuff

## Updates

I'll push security fixes when needed. GitHub will notify you about updates.

## Final Thoughts

This is a hobby project I built because I wanted to download videos easily. No hidden agenda, no data collection, no BS. It's open source so you can see exactly what it does.

If you find security issues, let me know and I'll fix them. If you have questions, open an issue.

## Legal Disclaimer

This software is provided "as is" without warranty. **Use at your own risk.** You are responsible for:

- Following laws in your jurisdiction
- Respecting website terms of service
- Not violating copyright
- Any consequences of using this tool

I made a tool. How you use it is on you.
