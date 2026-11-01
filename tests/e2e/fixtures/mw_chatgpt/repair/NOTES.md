# ChatGPT ask (offline fixture notes)

## Intent
Operator-present question answering in the operator's own logged-in ChatGPT tab: click the composer, paste the private prompt slot, press Return, wait for the answer's copy control.

## Starting state
The capsule shows the ChatGPT home with an empty composer. A sign-in dialog, CAPTCHA or unknown page stops automation for operator handoff.

## Variable slots
prompt: private runtime text, never persisted.

## Ambiguous controls
Composer and copy control are matched by their accessible names in the operator's locale (UNVERIFIED-LIVE offline draft); a locale or live-DOM change needs a new demo.

## Expected result
The answer container appears with its copy control; its visible text is captured privately after verification.

## Exceptions
Login and CAPTCHA walls hand off to the operator. No credential entry, solving, automatic retries or capsule restart.
