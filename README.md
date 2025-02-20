# Solana Escrow Smart Contract

A secure escrow smart contract built on Solana using the Anchor framework. This contract enables trustless token exchanges between parties by implementing a basic escrow mechanism.

## Overview

This escrow contract allows:
- An initializer to deposit tokens into an escrow vault
- A recipient to withdraw tokens from the escrow vault
- The initializer to cancel the escrow and reclaim their tokens

## Features

- **Secure Token Deposits**: Users can safely deposit tokens into a PDA-controlled vault
- **Trustless Withdrawals**: Recipients can claim tokens with proper authorization
- **Cancel Functionality**: Initializers can cancel and reclaim their deposits
- **PDA-based Security**: Uses Program Derived Addresses for secure token custody
- **Token Program Integration**: Built on Solana's SPL Token program

## Prerequisites

- [Rust](https://rustup.rs/) 1.70.0 or later
- [Solana Tool Suite](https://docs.solana.com/cli/install-solana-cli-tools) 1.18.0 or later
- [Anchor](https://www.anchor-lang.com/docs/installation) 0.30.1 or later
- [Node.js](https://nodejs.org/) 14.0.0 or later

## Installation

1. Clone the repository
```bash
git clone https://github.com/piyushmali/escrow-solana.git
cd escrow-solana
```

2. Install dependencies
```bash
npm install
```

3. Build the program
```bash
anchor build
```

## Usage

### Deploy the Program
```bash
anchor deploy
```

### Run Tests
```bash
anchor test
```

## Contract Structure

### Main Components

1. **Initialize**
   - Creates escrow account and vault
   - Transfers tokens from initializer to vault
   - Sets up escrow parameters

2. **Withdraw**
   - Allows recipient to claim tokens from vault
   - Validates recipient's token account
   - Transfers tokens from vault to recipient

3. **Cancel**
   - Allows initializer to cancel escrow
   - Returns tokens back to initializer
   - Closes escrow account

### Account Structures

1. **EscrowAccount**
   - Stores escrow state and configuration
   - Contains initializer's information
   - Tracks token amount and seeds

## Security Features

- PDA-based vault accounts
- Token account ownership verification
- Signer constraints
- Secure seed derivation
- Account validation checks

## Testing

The project includes comprehensive tests covering:
- Escrow initialization
- Token deposits
- Withdrawals
- Cancellation
- Error cases
- Invalid account validations

## Development

### Build
```bash
anchor build
```

### Test
```bash
anchor test
```

### Lint
```bash
npm run lint
```

### Format Code
```bash
npm run lint:fix
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Dependencies

- @coral-xyz/anchor: ^0.30.1
- @project-serum/anchor: ^0.26.0
- @solana/spl-token: ^0.4.12

## License

This project is licensed under the ISC License.

## Author

[Piyush Mali](https://github.com/piyushmali)

## Acknowledgments

- Solana Foundation
- Anchor Framework
- SPL Token Program
