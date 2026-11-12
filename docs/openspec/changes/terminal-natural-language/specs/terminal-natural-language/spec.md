## ADDED Requirements

### Requirement: Plain token amounts
A deposit prompt SHALL accept a plain token amount (digits with an optional dot, at most 18 decimals) and the code, not the model, SHALL convert it once to base units. A sign, separator, exponent, zero or a longer fraction MUST be refused, and the review SHALL show the exact base units and the token.

#### Scenario: Decimal amount
- **WHEN** the user asks to deposit 0.5 tokens
- **THEN** the intent carries 500000000000000000 base units and the review shows that amount

#### Scenario: Ambiguous amount
- **WHEN** the amount is 1,000, 1e6, -5 or 0
- **THEN** no intent is produced and the Terminal explains what a valid amount looks like

### Requirement: An open arena without a battle id
A join, registration or deposit intent SHALL be allowed to name no battle ("an open arena"). The Terminal SHALL read the open arenas, SHALL use an arena only when exactly one fits and say why, and SHALL list the candidates for the user to choose when several fit. It MUST NOT choose among several, and nothing is signed before the user reviews the resolved action.

#### Scenario: Exactly one fits
- **WHEN** exactly one open arena fits the request
- **THEN** the Terminal uses it, says it is the only one that fits, and shows the reviewed call

#### Scenario: Several fit
- **WHEN** several open arenas fit
- **THEN** the Terminal lists them with their mode, start and communities and waits for the user to pick one

#### Scenario: None fits
- **WHEN** no arena is open, or none has the named token
- **THEN** the Terminal says so and, for a deposit of a token no open arena has, offers to join one with that token first

### Requirement: Community by token
A deposit MAY name the community by its token instead of a number. The token SHALL be matched against the battle's own communities only; one match is used, no match offers to join with that token, and several matches are listed for the user to pick.

#### Scenario: Token matches one community
- **WHEN** the battle has one CASHCAT community and the user deposits CASHCAT
- **THEN** that community is used and the review names it

#### Scenario: Token not in the battle
- **WHEN** the battle has no community of the named token
- **THEN** the Terminal offers "join with that token first" and builds no deposit

### Requirement: Read-only questions
The Terminal SHALL answer "which arenas are open?" and "my positions" from the existing reads. These intents MUST NOT build an action request, MUST NOT reach the action service or the wallet signing path, and the position read SHALL use the wallet session the Portfolio uses.

#### Scenario: Open arenas
- **WHEN** the user asks which arenas are open
- **THEN** the Terminal lists the open arenas with links and prepares nothing to sign

#### Scenario: Positions without a wallet
- **WHEN** the user asks for their positions with no wallet connected
- **THEN** the Terminal asks them to connect a wallet and reads nothing

### Requirement: Model output stays a proposal
The NEAR AI parser SHALL only propose an intent from a fixed schema. Its output MUST be validated like any untrusted input: unknown fields, a receiver, a signer, an address, a battle reference other than a number or "open", both a community number and a token, or both amount forms are refused. The model MUST NOT perform amount arithmetic.

#### Scenario: Hostile model reply
- **WHEN** the model returns an intent with an extra receiver field
- **THEN** it is rejected and the built-in rules answer

### Requirement: Honest parser indicator
The Terminal SHALL show whether NEAR AI or the built-in rules understood the request and, when the rules answered because NEAR AI was not configured or failed, SHALL show the reason. The default model MUST be one that NEAR AI Cloud serves.

#### Scenario: NEAR AI not configured
- **WHEN** the web server has no NEAR AI key
- **THEN** the built-in rules answer and the Terminal says NEAR AI is not configured

#### Scenario: NEAR AI fails
- **WHEN** NEAR AI answers with an error or an invalid reply
- **THEN** the rules answer and the Terminal shows that NEAR AI could not answer and why

### Requirement: Bounded model use
The Terminal route SHALL bound how much NEAR AI one visitor and the whole server can spend: a per-visitor hourly limit, a total hourly and daily limit, a limit on concurrent calls, an operator kill switch and a per-visitor request-rate limit. Limit values SHALL come from server configuration, an invalid value MUST keep the safe default rather than disable a limit, and a model call refused by a limit MUST cost nothing: the built-in rules answer and the reply says why. A request flood SHALL be refused before any work is done.

#### Scenario: A visitor reaches the hourly limit
- **WHEN** one visitor has caused the configured number of model calls in the hour
- **THEN** their next prompt is answered by the built-in rules with the reason, and no model call is made

#### Scenario: The total budget is used up
- **WHEN** the hourly or daily total is reached
- **THEN** every visitor's prompts are answered by the built-in rules until the window passes

#### Scenario: Kill switch
- **WHEN** the operator switches the model off
- **THEN** no model call is made for anyone and the built-in rules answer

#### Scenario: Request flood
- **WHEN** one visitor exceeds the per-minute request limit
- **THEN** the route answers HTTP 429 and does no parsing or model work

### Requirement: Conversation layout
The Terminal SHALL present the exchange as a conversation: the user's prompts on one side and the Terminal's answers on the other, history stacking in order, the input fixed below, a visible indicator while a prompt is being read and the newest message kept in view. Only the latest answer SHALL be interactive: its review, signing and choice controls are live, and every earlier answer SHALL be a static summary with no action control. A choice made inside an answer SHALL become a new turn.

#### Scenario: A second prompt
- **WHEN** the user sends a second prompt
- **THEN** the first prompt and its answer stay above, the second appears below, and the first answer's review and sign controls are no longer available

#### Scenario: Choosing an arena from a list
- **WHEN** the user picks one of several listed arenas
- **THEN** the choice appears as a new turn with its own answer and the list it came from becomes static

#### Scenario: Reading a prompt
- **WHEN** a prompt is being parsed
- **THEN** a reading indicator is shown in the Terminal's side and a second prompt cannot be sent until it is answered

