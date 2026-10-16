# `@ecash-connect/ui`

A wallet selector for eCash (ECX) dapps, forked from [@sats-connect/ui](https://github.com/secretkeylabs/sats-connect-ui) (MIT, Secret Key Labs). Built as a custom element, compatible with all major UI frameworks.

## Basic usage

```ts
import { loadSelector, selectWalletProvider } from "@ecash-connect/ui";

// Call this once in your app to load the custom element.
loadSelector();

// At a later point,
//
// 1. Decide which wallet providers should be displayed to the user.
// 2. Display the selector and capture the user's selection.

// (1)
const providersToDisplay = someBusinessLogic();
// (2)
const userSelectedProviderId = await selectWalletProvider(providersToDisplay);
```

# Development

An example app using the selector is included for convenience during development. To get started, run

```bash
npm install
npm run dev
```

# Building the `@ecash-connect/ui` package

To build the `@ecash-connect/ui` package, run

```bash
npm run build
```

# Building the example app

To build the example app use

```bash
npm run build-app
```

## Viewing the example app live


# Docs

Technical documentation is in the [`docs`](./docs/) folder.
