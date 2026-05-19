# Blink Terminal

A powerful Bitcoin Lightning terminal for Blink power users. Execute advanced operations, manage vouchers, process batch payments, accept payments with automatic forwarding, and leverage the full capabilities of your Blink account.

![License](https://img.shields.io/badge/license-MIT-green.svg)
![Next.js](https://img.shields.io/badge/Next.js-12.3.4-black.svg)
![React](https://img.shields.io/badge/React-18.0.0-blue.svg)
![Bitcoin](https://img.shields.io/badge/Bitcoin-Lightning-orange.svg)

## Features

### Point of Sale

- **Real-time Payment Detection**: WebSocket connections for instant payment notifications
- **Dynamic Currency Support**: All 71+ fiat currencies from Blink with automatic formatting
- **NFC Payments**: Web NFC integration for contactless payments (NTAG424DNA compatible)
- **Item Cart Mode**: Optional cart for multi-item transactions
- **Payment Animations**: Full-screen celebratory animations for incoming payments

### Voucher System

- **Single Vouchers**: Create individual LNURL-withdraw vouchers with QR codes
- **Multi-Voucher Batches**: Generate multiple vouchers at once (up to 24) for events or distributions
- **Configurable Expiry**: Set voucher expiration (1 hour to never expires)
- **Commission Support**: Optional commission percentage for resellers/distributors
- **PDF Generation**: Print-ready PDFs in multiple formats:
  - A4 and Letter paper sizes
  - Thermal printer formats (58mm and 80mm)
  - Grid layouts (2x2, 2x3, 3x3, 3x4 vouchers per page)
- **Voucher Manager**: Comprehensive dashboard to track all vouchers
  - Filter by status: Active, Claimed, Expired, Cancelled
  - Sort by recent activity or soonest expiry
  - Real-time status updates
  - Cancel unclaimed vouchers
  - View redemption details and timestamps
- **PostgreSQL Persistence**: Vouchers persist across deployments

### Batch Payments

- **CSV Import**: Upload recipient lists for bulk payments
- **Validation**: Automatic validation of Lightning addresses and amounts
- **Progress Tracking**: Real-time status updates during batch execution

### Payment Forwarding & Tipping

- **Split Payments**: Automatically split payments between merchant and tip recipient
- **Zero-Fee Forwarding**: Uses Blink intraledger transactions for instant, free forwarding
- **Flexible Destinations**: Forward to Blink usernames, Lightning Addresses, or npub.cash addresses
- **npub.cash Integration**: Special support for npub.cash addresses with zero-fee forwarding
- **Configurable Presets**: Set custom tip percentages (e.g., 10%, 15%, 20%)

### Wallet Connectivity

- **Blink Integration**: Direct connection to Blink API for zero-fee intraledger transactions
- **NWC Support**: Connect external wallets via Nostr Wallet Connect
  - Blink-based NWC benefits from zero-fee instant payments
  - External NWC wallets fully supported for invoice creation and payments
- **Multi-Wallet Management**: Link and manage multiple Blink accounts

### Authentication

- **Nostr Authentication**: NIP-07 (browser extensions) and NIP-55 (external signers like Amber)
- **Cross-Device Sync**: Profile settings and credentials sync across devices when authenticated via Nostr
- **Encrypted Storage**: Client-side encryption for sensitive credentials (API keys, NWC URIs)

### Transaction Management

- **Transaction History**: Comprehensive logs with status tracking and memo support
- **CSV Export**: Export transaction data for accounting
- **Network Analytics**: Transaction heatmaps and statistics

## Architecture

### System Overview

```
Frontend (Next.js) → Direct Blink WebSocket → Instant Payment Detection
                  → API Routes → Hybrid Storage (Redis + PostgreSQL)
                              → Blink GraphQL API
```

### Key Components

- **Frontend**: Next.js with React hooks and Tailwind CSS
- **Authentication**: Nostr-based auth with JWT sessions
- **Real-time**: Direct WebSocket connection to Blink API (wss://ws.blink.sv/graphql)
- **Storage**: Hybrid architecture with Redis (hot data) and PostgreSQL (cold data)
- **PDF Generation**: React-PDF for vouchers and transaction receipts

### Hybrid Storage Architecture

- **Redis**: Sub-millisecond access to active payments and hot data (24h TTL)
- **PostgreSQL**: Permanent storage for transaction history, vouchers, and analytics
- **Automatic Migration**: Data flows from Redis to PostgreSQL after completion

### Redis Key Conventions

All Redis keys are prefixed with `blink-terminal:` to prevent collisions when sharing a Redis instance with other services:

| Key Pattern | Purpose | TTL |
|---|---|---|
| `blink-terminal:rate:{provider}:{CURRENCY}` | Exchange rate cache | 45s |
| `blink-terminal:payment:{paymentHash}` | Active payment data (hot cache) | 15-30min |

## Quick Start

### Prerequisites

- Node.js 14+
- Docker and Docker Compose (for Redis and PostgreSQL)
- A Blink API key from [Blink Dashboard](https://dashboard.blink.sv)

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/blinkbitcoin/blink-terminal.git
   cd blink-terminal
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Start database services:**

   ```bash
   docker-compose up -d
   ```

4. **Configure environment variables:**
   Create `.env.local` with:

   ```bash
   JWT_SECRET=your-strong-jwt-secret-key
   ENCRYPTION_KEY=your-strong-encryption-key
   NODE_ENV=development

   # Database
   REDIS_URL=redis://localhost:6379
   DATABASE_URL=postgresql://user:password@localhost:5432/blinkpos
   ```

5. **Start the development server:**

   ```bash
   npm run dev
   ```

6. **Access the application:**
   Open [http://localhost:3000](http://localhost:3000)

### Usage

1. **Authenticate**: Sign in with Nostr (NIP-07 extension or NIP-55 signer) or enter Blink credentials directly
2. **Configure**: Set up your Blink account, NWC connections, and preferences in Settings
3. **Operate**: Use the terminal for payments, vouchers, batch operations, and more
4. **Monitor**: Track transactions, balances, and statistics in the Dashboard

## Project Structure

```
blink-terminal/
├── components/
│   ├── Dashboard.js           # Main dashboard interface
│   ├── POS.js                 # Point of Sale interface
│   ├── ItemCart.js            # Cart mode for multi-item transactions
│   ├── Voucher.js             # Single voucher creation
│   ├── MultiVoucher.js        # Batch voucher generation
│   ├── VoucherManager.js      # Voucher tracking and management
│   ├── BatchPayments.js       # Bulk payment processing
│   ├── Network.js             # Network analytics and heatmaps
│   ├── TransactionDetail.js   # Transaction detail view
│   ├── PaymentAnimation.js    # Payment celebration overlay
│   ├── NFCPayment.js          # NFC payment handling
│   ├── ExpirySelector.js      # Voucher expiry configuration
│   ├── auth/                  # Authentication components
│   ├── wallet/                # Wallet setup components
│   └── Settings/              # Settings page sections
├── lib/
│   ├── blink-api.js           # Blink GraphQL API integration
│   ├── voucher-store.js       # Voucher PostgreSQL storage
│   ├── voucher-expiry.js      # Voucher expiration utilities
│   ├── storage/               # Hybrid storage implementation
│   ├── nostr/                 # Nostr authentication services
│   ├── network/               # Network analytics
│   ├── batch-payments/        # Batch payment processing
│   ├── pdf/                   # PDF generation (vouchers, receipts)
│   ├── nwc/                   # Nostr Wallet Connect
│   └── migration/             # Data migration utilities
├── pages/
│   ├── api/
│   │   ├── blink/             # Blink API proxy endpoints
│   │   ├── voucher/           # Voucher management endpoints
│   │   ├── batch-payments/    # Batch payment endpoints
│   │   ├── network/           # Network analytics endpoints
│   │   └── user/              # User management endpoints
│   ├── _app.js                # App wrapper
│   └── index.js               # Main page
├── database/                  # Database schemas and migrations
├── public/                    # Static assets
├── scripts/                   # Utility scripts
└── types/                     # TypeScript type definitions
```

## Configuration

### Environment Variables

| Variable         | Description                                          | Required |
| ---------------- | ---------------------------------------------------- | -------- |
| `JWT_SECRET`     | Secret for JWT token signing (64+ chars recommended) | Yes      |
| `ENCRYPTION_KEY` | Key for API key encryption (32+ chars recommended)   | Yes      |
| `NODE_ENV`       | Environment (development/production)                 | Yes      |
| `REDIS_URL`      | Redis connection URL                                 | Yes      |
| `DATABASE_URL`   | PostgreSQL connection URL                            | Yes      |
| `WEBHOOK_SECRET` | Secret for Blink webhook verification                | Optional |

### Example `.env.local`:

```bash
JWT_SECRET=your-super-strong-jwt-secret-key-here
ENCRYPTION_KEY=your-super-strong-encryption-key-here
NODE_ENV=development
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://blinkpos:password@localhost:5432/blinkpos
```

## API Endpoints

### Authentication

| Endpoint                | Method | Description                     |
| ----------------------- | ------ | ------------------------------- |
| `POST /api/auth/login`  | POST   | Authenticate with Blink API key |
| `POST /api/auth/logout` | POST   | Clear user session              |
| `GET /api/auth/verify`  | GET    | Verify current session          |

### Blink Integration

| Endpoint                         | Method | Description                |
| -------------------------------- | ------ | -------------------------- |
| `GET /api/blink/balance`         | GET    | Get wallet balances        |
| `GET /api/blink/transactions`    | GET    | Get transaction history    |
| `POST /api/blink/create-invoice` | POST   | Create Lightning invoice   |
| `GET /api/blink/check-payment`   | GET    | Check payment status       |
| `GET /api/blink/exchange-rate`   | GET    | Get current exchange rates |
| `GET /api/blink/csv-export`      | GET    | Export transactions as CSV |
| `POST /api/blink/webhook`        | POST   | Receive Blink webhooks     |

### Vouchers

| Endpoint                                   | Method | Description                            |
| ------------------------------------------ | ------ | -------------------------------------- |
| `POST /api/voucher/create`                 | POST   | Create new voucher                     |
| `GET /api/voucher/list`                    | GET    | List all vouchers with filtering       |
| `GET /api/voucher/status/:chargeId`        | GET    | Check voucher status                   |
| `POST /api/voucher/cancel`                 | POST   | Cancel an unclaimed voucher            |
| `POST /api/voucher/pdf`                    | POST   | Generate voucher PDF (single or batch) |
| `GET /api/voucher/lnurl/:chargeId/:amount` | GET    | LNURL-withdraw endpoint                |
| `POST /api/voucher/callback`               | POST   | LNURL callback for redemption          |

### Batch Payments

| Endpoint                            | Method | Description             |
| ----------------------------------- | ------ | ----------------------- |
| `POST /api/batch-payments/validate` | POST   | Validate recipient list |
| `POST /api/batch-payments/execute`  | POST   | Execute batch payments  |

## Real-time Payment Detection

### How it Works:

1. **Invoice Created**: Backend generates Lightning invoice via Blink API
2. **WebSocket Connection**: Frontend establishes direct connection to `wss://ws.blink.sv/graphql`
3. **Subscription**: Subscribes to `myUpdates` GraphQL subscription
4. **Payment Received**: Blink sends real-time transaction data
5. **Animation Triggered**: Full-screen celebration animation displays
6. **Forwarding**: If configured, payment is automatically split and forwarded
7. **Storage Updated**: Transaction recorded in Redis and archived to PostgreSQL

## Deployment

### Development

```bash
npm run dev
```

### Production Build

```bash
npm run build
npm start
```

### Docker Deployment

```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Deployment Platforms

- Vercel (recommended for Next.js)
- Docker with Nginx reverse proxy
- Any Node.js hosting with Redis and PostgreSQL

## Implementation Status

| Feature                               | Status      |
| ------------------------------------- | ----------- |
| Hybrid Storage (Redis + PostgreSQL)   | Completed   |
| Payment Forwarding & Tipping          | Completed   |
| Dynamic Currencies (71+)              | Completed   |
| WebSocket Payment Detection           | Completed   |
| Transaction History & CSV Export      | Completed   |
| NWC Integration                       | Completed   |
| Lightning Address Forwarding          | Completed   |
| npub.cash Integration                 | Completed   |
| Cross-Device Sync                     | Completed   |
| NFC Payments                          | Completed   |
| Nostr Authentication (NIP-07, NIP-55) | Completed   |
| Single Voucher Creation               | Completed   |
| Multi-Voucher Batch Generation        | Completed   |
| Voucher Manager Dashboard             | Completed   |
| Voucher PostgreSQL Persistence        | Completed   |
| Batch Payments                        | Completed   |
| In-App Key Generation                 | In Progress |
| WebAuthn/Passkeys                     | Planned     |

## Related Resources

- [Blink API Documentation](https://dev.blink.sv/) - Official Blink API docs
- [Blink Dashboard](https://dashboard.blink.sv) - Get your API key
- [Nostr Wallet Connect (NIP-47)](https://github.com/nostr-protocol/nips/blob/master/47.md) - NWC specification

## Contributing

Contributions are welcome! This project is licensed under the MIT License:

- Free to use for any purpose, including commercial
- Modify and distribute your changes freely
- Help make Bitcoin tools accessible to everyone

### Development Guidelines

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the **MIT License**.

See the [LICENSE](LICENSE) file for details.

## Acknowledgments

- **Blink** for the Lightning payment infrastructure
- **Bitcoin Lightning Network** for instant, low-fee payments
- **Nostr Protocol** for decentralized authentication
- **Next.js & React** for the development framework
- **The open source community** for inspiration and tools

## Support

- **Issues**: [GitHub Issues](https://github.com/blinkbitcoin/blink-terminal/issues)
- **Blink Support**: [Blink Developer Docs](https://dev.blink.sv/)

---

**Built for the Bitcoin Lightning Network**
