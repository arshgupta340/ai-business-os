# Twilio and AgentPhone: comparison checklist (D-12)

Fill this in while testing both providers. Switch with `TELEPHONY_PROVIDER` (docs/DEPLOY.md, "Switching the telephony provider"). Use the same agent version, the same test phone and the same script of calls for both. Write a number or a short note in each cell, and the date of the test.

Test date: ____________ Tester: ____________ Agent version: ____________

## Calls

| Check | How to measure | Twilio | AgentPhone |
|---|---|---|---|
| Call setup time | Seconds from dialing to the first ring answered |  |  |
| First-audio delay | Seconds from answer to the first word the caller hears |  |  |
| Reply delay per turn | Seconds from the caller stopping to the agent starting, over 5 turns (median) |  |  |
| Barge-in | Talk over the agent mid-sentence 3 times: does it stop and listen? |  |  |
| Transcription quality | Read the same 5 sentences (an order with a modifier, a name, a pickup time, a phone number, a price question); count the words the agent got wrong |  |  |
| Voice quality | 1 to 5, and what sounded off |  |  |
| Order flow | Quote, then propose: does the approval card appear with the right cart and total? |  |  |
| Owner decision mid-call | Approve while the caller is on the line: when does the caller hear it? |  |  |
| Hang-up | Caller hangs up: is the call row COMPLETED within a minute? |  |  |
| Silence and timeouts | Stay silent for 20 seconds; any dead air or dropped call? |  |  |

## Texts

| Check | How to measure | Twilio | AgentPhone |
|---|---|---|---|
| SMS registration state | Twilio: D-11 (10DLC, error 30034). AgentPhone: `outboundSms` in health |  |  |
| SMS delivery | An approved checkout link reaches the test phone: yes or no, and seconds |  |  |
| Link passes the carrier filter | The Square sandbox link arrives intact |  |  |
| Delivery status | Does the dispatch reach DELIVERED in the dashboard? |  |  |

## Webhooks and operations

| Check | How to measure | Twilio | AgentPhone |
|---|---|---|---|
| Webhook reliability | Over 10 calls, any rejected (401) or missing webhook in the server log? |  |  |
| Duplicate deliveries | Any repeated event that changed state twice? (it should not) |  |  |
| Setup effort | Minutes from a new account to a working call |  |  |
| Cost | Per number per month, per call minute, per text (from the bill, not the price page) |  |  |

## Verdict

Which provider for the demo, and why (two or three sentences):
