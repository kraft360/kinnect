# Phase 0 spike results

> Historical record: the push-delivery experiment run before Kinnect was built, to check Web Push was reliable enough for medicine reminders. Its findings shaped the phone setup checklist.

| | |
|---|---|
| **Date** | 12 Oct 2026 |
| **Phone** | Android phone with Chrome |

## Delivery

| # | Test | Battery setting | Scheduled | Sent + | Shown + | Notes |
|---|---|---|---|---|---|---|
| 1 | App closed, screen locked, 1 min | Optimised | 10:56:02 | 0 s | 0 s (notification text: 2 s late, phone clock) | Worked after the fixes below |
| 2a | App closed, screen locked, 10 min | Optimised | 11:08:18 | 0 s | 109 s (shown 11:10:07) | Held by the phone until it was unlocked at 11:10 |
| 2b | App closed, screen off, 30 min | Optimised | | | | |
| 3 | Idle ≥ 1 hour, 60 min | Optimised | | | | |
| 4a | App closed, screen locked, 10 min | Kinnect Unrestricted, Chrome Optimised | 11:30:11 | 0 s | 322 s (shown 11:35:33) | Held by the phone |
| 4b | App closed, screen locked, 10 min | Kinnect and Chrome Unrestricted | 11:47:03 | 0 s | 1 s (shown 11:47:04) | On time, phone locked |
| 4c | Idle ≥ 1 hour, 60 min | Kinnect and Chrome Unrestricted | | | | |

## CPU per alarm run

| Pushes in run | CPU time (ms) | ms per push |
|---|---|---|
| 10 | 8 | 0.8 |
| 40 | 19 | 0.5 |

All 50 pushes were accepted (HTTP 201); no limit errors. Wall time: 337 ms and 676 ms. The 10-push burst was shown on the locked phone 4 s after it was due.

## Other checks

| # | Check | Result |
|---|---|---|
| 6 | Expired subscription shows as "gone" (404/410) | Passed: after a permission change, FCM returned 410 and the subscription was marked gone |
| 7 | Done button works without opening the app | Passed: Done on pushes 6 and 7 was recorded on the server |

## Findings so far

1. **Installing the app turned its Android notifications off.** Chrome had permission, but the installed app (a separate Android app) had notifications off in Android settings. The push reached the phone and the service worker ran, but nothing was displayed. Kinnect onboarding and the FR-42 warning must check this after install.
2. **Changing notification permission invalidates the push subscription.** The next push got `410 Gone` and the server marked the subscription dead (FR-45 works). The app must re-send its current subscription to the server every time it opens.
3. **One phone can have two subscriptions** (Chrome tab and installed app). A device record should replace its previous subscription instead of adding another.
4. **Chrome's battery setting decides delivery on this phone.** With Chrome on "Optimised", locked-phone pushes waited until the phone was unlocked (2–5 min in tests, possibly much longer). Setting only Kinnect to "Unrestricted" didn't help. With **Chrome** on "Unrestricted", the push was shown within 1 second on a locked phone. Kinnect onboarding must guide members to set Chrome (not just the app) to Unrestricted.
5. **"Shown" must be reported only after `showNotification` succeeds.** The first version reported it regardless, which hid finding 1.

## Conclusion

- **CPU is not a constraint.** About 0.5–0.8 ms per push; a 40-push run used 19 ms and completed normally. A missed alert to every device of every watcher in a 15-member family is well under this.
- **Per-run push cap for requirements 7.3: 40.** Kept below the free plan's subrequest limit per invocation (believed to be 50; not tested above 40).
- **Go**, with one condition: on Android, members must set **Chrome's** battery usage to Unrestricted, and the app must check notifications are enabled for the installed app. Without this, pushes on this phone waited until it was unlocked.
- **Not yet tested:** delivery after an hour or more of idle (Doze) with Unrestricted battery, and iPhone. Run the 60-min test when convenient before relying on reminders for someone's medicines.
