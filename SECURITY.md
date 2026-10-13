# Security

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on
[kraft360/kinnect](https://github.com/kraft360/kinnect/security/advisories/new). Don't open a public issue.

This is a personal project, so there is no guaranteed response time, but reports are read and fixed as soon as possible.

## Trust model

Kinnect is built for a family that trusts each other, run by someone the family trusts. Each deployment is
self-hosted: there is no shared public instance.

**The operator** (whoever deploys it to their Cloudflare account) can see and do everything:
- The Cloudflare account holds every family's data. It isn't end-to-end encrypted.
- `OPERATOR_SECRET` signs "create family" links and owner-recovery links (FR-61, FR-64). A recovery link
  signs a new device in as a family's owner, so anyone with the secret can take over any family.

**Admins** (including the owner) are fully trusted within their family:
- **An admin can sign in as any member, including the owner.** There are no passwords. A new phone is signed in
  with an "add device" link (FR-77), and any admin can create one for any member. This is deliberate: it is how a
  family member who lost their phone gets back in, without email or SMS.
- The new device shows up in that member's device list (FR-78), where the member and every admin can see and
  sign it out. The member isn't notified otherwise.
- Admins can see every household's tasks (FR-87), change other members' roles (except the owner's), sign out any
  device, and download all the family's data (FR-92).

So only make someone an admin if you'd trust them with everyone's account.

**Members** see family-wide tasks and the tasks of households they belong to (FR-82 to FR-84). The server
enforces this on every request and on live sync, not just in the app.

## Sign-in

- **Sessions:** a random token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, valid for a year. The server
  stores only its SHA-256 hash. Signing out a device ends its session immediately and closes its live connection.
- **Invite and add-device links** carry a 256-bit random token, are single-use, expire after 48 hours and are
  stored only as hashes. Opening a link doesn't use it up; only tapping **Join** does (FR-73), so chat-app link
  previews can't.
- **Join codes** (for the installed iPhone app, FR-75) are 6 characters from a 32-letter alphabet: about one
  billion possible codes. They expire with their link.
- **Cross-site requests:** requests that change something, and the live-sync connection, are refused unless
  they come from the app's own origin. The web app sends a strict Content Security Policy and can't be embedded
  in other sites.

## Known limitation: join codes can be blocked for an hour

Join-code attempts are limited to 30 per IP address per hour and **300 per hour across the whole deployment**
(FR-79). The global limit is what keeps guessing impractical: at 300 guesses an hour, finding a live code in
about a billion takes far longer than the 48 hours a code lasts.

The cost is that anyone, signed in or not, can use up the 300 attempts with wrong guesses from 10 or more IP
addresses (easy with cloud servers or IPv6). Joining **by code** is then refused for everyone until the next
clock hour starts. Nothing else is affected:
- invite and add-device **links** keep working, as does everything for devices already signed in;
- no code is used up or revealed.

If this happens, send the person the link instead of the code, or wait for the next hour.
