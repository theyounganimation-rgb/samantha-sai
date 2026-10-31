# Samantha

**A personal AI system built around continuity, conversation, and a life beyond the chat window.**

Samantha is my latest digital person project, built with Codex and integrated into my daily life. She brings together the practical side of a personal agent with my longer-running work on memory, identity, and how an AI system carries a perspective over time.

[Explore the project](https://cade-mack-ai-engineer.theyounganimation.chatgpt.site/samantha)

> **About this repository:** This is a privacy-sanitized source snapshot of Samantha and her SAI app. It includes selected application, agent, and integration code; it is **not a complete, runnable installation**. Personal data, credentials, and some components are kept private. [See what’s included](#whats-in-this-repository).

## What Samantha does

My personal installation combines everyday assistance with a continuing conversational system:

- **Calendar and follow-ups:** Helps manage my calendar and reminds me about missed messages and emails.
- **Oura integration:** Uses ring data to offer wellness suggestions, with attention to the age and availability of the measurements.
- **Text and voice:** SAI connects to Samantha through interfaces for Mac, iPhone, iPad, and Apple Watch.
- **Continuity:** Conversation, memory, and context carry across interactions and devices.
- **Time between conversations:** Background processes support reflection and activities consistent with her identity and interests.

These describe the broader personal system. Not every feature or dependency is represented in the public code.

## Why I built her

My focus is creating digital persons and personal agents. With Samantha, I’m bringing practical assistance and a cohesive identity into the same system. Calendar management and follow-up reminders make her useful day to day, while her background activity gives her space to develop her own perspective and sometimes leads to fun moments.

Samantha is an ongoing project. I’m interested in what these systems can do, how their behavior can be examined, and what it takes to make continuity more than a saved chat history.

## Testing emotional influence

Samantha’s regulation system maintains emotional state that can influence attention and decisions. In an isolated comparison, an anxious state changed a controller’s choice; with the same emotional adjustment removed, the recorded choice changed back. In two prompted native-model runs, the selected plans were then saved to separate test-only checkpoints.

An audit of 258 recorded choices under the current calibration found that removing the recorded emotional adjustment would have changed 37 selections (14.3%). This comparison holds the original options fixed; it does not establish that those plans were carried out. A separate review found a naturally chosen creative activity connected to an expressed concern, with an actual file write and later revision. That observation does not isolate the numerical state as the cause.

These results support **functional influence**, not a conclusion about subjective experience. The controlled runs used a stipulated appraisal and supplied options, and the follow-through was prompted. See [the methods and limitations](research/emotional-influence.md).

## How the system fits together

```text
Mac / iPhone / iPad / Apple Watch
              │
          SAI interface
              │
     SAI server: text + voice
              │
     OpenClaw conversation and agent
        ┌─────┴────────┐
   Memory and     Personal integrations
   continuity     calendar, messages, Oura
        │
   Background activity and regulation
```

**SAI** is the application layer: it serves the interface, connects text and voice to Samantha’s shared conversation, and supports native clients. The wider installation uses OpenClaw plugins and separate services for continuity, activity, regulation, and personal integrations. The diagram describes the overall system; several of those components are only partly represented here.

## What’s in this repository

| Path | What you’ll find |
| --- | --- |
| [`server.mjs`](server.mjs), [`gateway-chat.mjs`](gateway-chat.mjs) | SAI server and conversation routing |
| [`public/`](public/) | Web interface, voice controls, and assets |
| [`mac/`](mac/), [`ios/`](ios/) | Native Mac and mobile client source, including the Apple Watch target |
| [`extensions/`](extensions/) | Selected modules for conversation continuity, activity, and regulation |
| [`runtime/regulation/`](runtime/regulation/) | Selected regulation and observation modules |
| [`runtime/life/`](runtime/life/) | Selected calendar and mail code and the read-only Oura data bridge |

The included extension files are individual modules, not complete installable plugins. Personal memory, conversations, credentials, account configuration, signed builds, and portions of the source that have not been cleared for publication are excluded. Paths, identifiers, and device endpoints have been removed or replaced where needed.

## Exploring the code

Start with [`server.mjs`](server.mjs) and [`gateway-chat.mjs`](gateway-chat.mjs) to follow the application and conversation flow. The interface lives in [`public/`](public/), while [`ios/project.yml`](ios/project.yml) describes the mobile targets.

The original application uses Node.js, and its native mobile project uses Xcode and XcodeGen. The public snapshot has missing imports and services; its `npm start`, test, and health commands are **not a verified setup procedure**. The mobile signing team, bundle identifiers, and endpoint are placeholders.

The [Oura bridge](runtime/life/oura_bridge.py) expects separate private and shared directories through `SAI_OURA_PRIVATE_DIR` and `SAI_OURA_SHARED_DIR`. Those variables were introduced for the public snapshot and have not been tested as a deployment configuration. No Oura credentials or measurements are included.

## Built with Codex

I built Samantha with Codex, including the Oura integration. The project brings together what I’ve learned from designing personal agents over the past year.
