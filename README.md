# market-notify

Yandex Market -> Telegram notifier for the Belabor seller account.

Runs every 15 minutes via GitHub Actions (`.github/workflows/notify.yml`) and checks:
- new orders / order status changes
- new product reviews + unanswered-review reminders (24h+)
- new buyer chat messages
- new returns / unredeemed items
- low stock (<= 3 units)

Config lives in repo Secrets (Yandex API key, campaign/business id, Telegram bot token/chat id).
