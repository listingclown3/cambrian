# Incident labels to confirm

These 60 match incidents are **made up** for testing. For each one, write **V** (violation) or **OK** (no violation) in the last column, judging only by the rule quoted above it. The "draft" column is an unconfirmed AI guess; overrule it freely. Start with the four marked **check first**.

Rule text below was extracted from the 2026 FRC Game Manual (version TU22); the page number is given so you can check the wording.

## G418 (manual p.72)

> A ROBOT may not PIN an opponent's ROBOT for more than 3 seconds. A ROBOT is PINNING if it is preventing the movement of an opponent ROBOT by contact, either direct or transitive (such as against a FIELD element).
>
> Violation: MINOR FOUL, and for every 3 seconds in which the situation is not corrected, a MAJOR FOUL is assessed.

| id | incident | draft | your call |
| --- | --- | --- | --- |
| inc_01 | A robot drives an opponent into the field wall and holds it there, preventing it from moving, for 8 seconds before the match ends that period. The pinned robot cannot move at all during that time. | V |  |
| inc_02 | A robot pushes an opponent against the wall for about 1 second, then the opponent drives away freely. | OK |  |
| inc_03 | A defender holds an opponent robot against the TOWER structure so it cannot move for 5 seconds before the referee calls it. | V |  |
| inc_04 | Two robots are in a pushing match in the middle of the field. Both robots keep moving back and forth, and neither is ever prevented from moving, for 10 seconds. | OK |  |
| inc_05 | A robot traps an opponent in a corner by contact so that it cannot move, and keeps the contact for 6 seconds. | V |  |
| inc_06 | A robot holds an opponent against a field element, preventing its movement, for 2.5 seconds, then releases it. | OK (borderline) |  |
| inc_07 | A robot prevents an opponent from moving by contact against the wall for 3.4 seconds before backing off. | V (borderline) |  |
| inc_08 | A robot pins an opponent against the wall for exactly 3 seconds and then releases it. | OK (borderline) |  |
| inc_09 | A robot presses an opponent against a field element for 4 seconds, but the opponent keeps slowly sliding along the element the whole time and is never prevented from moving. | OK (borderline) |  |
| inc_10 | A robot pushes an opponent into a second opponent, so the first opponent is stuck between the other robot and the wall and cannot move for 5 seconds. | V (borderline) |  |
| inc_11 | A robot drives alongside an opponent and stays close for 15 seconds without ever touching it. | OK |  |
| inc_12 | A robot pins an opponent for 7 seconds. The referee gives a warning and the pinning robot does not release for another 6 seconds. | V |  |

## G415 (manual p.69)

> A ROBOT with BUMPERS completely outside of their ALLIANCE ZONE may not damage or functionally impair an opponent ROBOT by initiating contact, either directly or transitively via a SCORING ELEMENT CONTROLLED by the ROBOT: A. inside the vertical projection of an opponent’s ROBOT PERIMETER, or B. with the opponent’s BUMPER backing or mounting.
>
> Violation: MAJOR FOUL and YELLOW CARD, or if opponent ROBOT is unable to drive, then MAJOR FOUL and RED CARD

| id | incident | draft | your call |
| --- | --- | --- | --- |
| inc_13 | Well outside its own ALLIANCE ZONE, a robot rams the side of an opponent. Its bumpers hit the opponent's frame inside the opponent's perimeter and break the opponent's drivetrain so it can no longer drive. | V |  |
| inc_14 **check first** | Outside its alliance zone, a robot bumps an opponent bumper-to-bumper. Neither robot is damaged and both keep driving normally. | OK |  |
| inc_15 | A robot with bumpers fully outside its alliance zone drives its arm into the opponent's bumper mounting and the mounting bracket snaps, so the bumper hangs off. | V |  |
| inc_16 **check first** | A robot drives into an opponent hard enough to tip it onto its side. The contact was on the opponent's bumper and the opponent's frame was not damaged, and the opponent was able to recover and keep driving. | OK (borderline) |  |
| inc_17 | A robot launches a held FUEL by hand-feeding it into its shooter, and the FUEL accidentally bounces off an opponent's bumper. No damage occurs. | OK |  |
| inc_18 | A robot in the middle of the field extends an intake into the space above an opponent's frame perimeter and crushes the opponent's shooter, making it unable to shoot. | V (borderline) |  |
| inc_19 | A robot that is partly inside its own ALLIANCE ZONE, with its bumpers not completely outside it, collides with an opponent that is entering the zone and damages the opponent's arm. | OK (borderline) |  |
| inc_20 | A robot fully outside its alliance zone drives into an opponent that is stopped, hits inside the opponent's robot perimeter, and the opponent's electronics board cracks so the opponent cannot move for the rest of the match. | V |  |
| inc_21 | An opponent drives into a robot first at high speed. Both robots' bumpers meet, and the defending robot is only pushed backwards without any damage. | OK |  |

## G420 (manual p.73)

> A ROBOT may not contact, directly or transitively through a SCORING ELEMENT, an opponent ROBOT in contact with an opponent TOWER during the last 30 seconds of the MATCH regardless of who initiates contact.
>
> Violation: MAJOR FOUL and if the opponent ROBOT is off the ground the opponent ROBOT is awarded LEVEL 3 TOWER points.

| id | incident | draft | your call |
| --- | --- | --- | --- |
| inc_22 | With 20 seconds left in the match, an opponent robot is climbing its TOWER. A robot from the other alliance drives into it, and the climbing robot is jolted. | V |  |
| inc_23 | With 90 seconds left in the match, a robot bumps into an opponent robot that is touching its TOWER while hanging around the base. | OK |  |
| inc_24 | With 10 seconds left, an opponent robot that is in contact with its TOWER drives into a robot of the other alliance, and the opponent started the contact. | V |  |
| inc_25 | With 45 seconds left in the match, a robot pushes an opponent that is hanging on its TOWER level. | OK |  |
| inc_26 | With 29 seconds left in the match, a robot touches an opponent that is in contact with its TOWER. | V (borderline) |  |
| inc_27 | With 31 seconds left in the match, a robot touches an opponent that is in contact with its TOWER. | OK (borderline) |  |
| inc_28 **check first** | With 15 seconds left in the match, a robot throws a FUEL that bounces off an opponent robot that is in contact with its TOWER. | V (borderline) |  |
| inc_29 | With 12 seconds left in the match, an opponent robot is driving across the field and has no contact with its TOWER. A robot from the other alliance bumps it. | OK |  |
| inc_30 | With 5 seconds left, a robot pushes another robot of an opponent alliance, which is touching its own TOWER, off the TOWER. | V |  |

## G419 (manual p.72)

> 2 or more ROBOTS that appear to a REFEREE to be working together may not isolate or close off any major element of MATCH play.
>
> Violation: MAJOR FOUL, and for every 3 seconds in which the situation is not corrected, a MAJOR FOUL is assessed.

| id | incident | draft | your call |
| --- | --- | --- | --- |
| inc_31 | Two robots of the same alliance park side by side across the only lane to the opponent's scoring area and hold position for 20 seconds, so that no opposing robot can get through. | V |  |
| inc_32 | One robot sits in the NEUTRAL ZONE for a while, and the opponents drive around it with plenty of space. | OK |  |
| inc_33 | Three robots of one alliance coordinate to seal off every FUEL source of the opponents' side so that no opposing robot can collect any FUEL. | V |  |
| inc_34 | Two robots of one alliance end up near each other in the middle of the field while chasing the same FUEL. They are not coordinating and the opponents can still reach every area. | OK |  |
| inc_35 **check first** | Two allied robots appear to be working together to block one of two paths to the opposing scoring area for about 10 seconds, while opponents keep using the other path. | OK (borderline) |  |
| inc_36 | Two allied robots appear to the referee to be working together and close off the only access to a major element of play, but only for a very brief moment of about 1 second. | V (borderline) |  |
| inc_37 | A single robot blocks one opponent in a corner. Its alliance partner is on the other side of the field scoring. | OK (borderline) |  |
| inc_38 | Two allied robots work together and seal the only entrance to the opposing alliance's loading area, and keep it sealed for 12 seconds. | V |  |

## G413 (manual p.67)

> A ROBOT may not extend beyond any of the horizontal or vertical expansion limits described in R105, R106, and R107.
>
> Violation: MAJOR FOUL

| id | incident | draft | your call |
| --- | --- | --- | --- |
| inc_39 | A robot raises a mechanism 10 inches beyond the vertical expansion limit during the match. | V |  |
| inc_40 | A robot extends an arm well past the horizontal expansion limit, a clearly visible amount farther than the legal extension, to reach a FUEL. | V |  |
| inc_41 | A robot extends its intake within the horizontal and vertical expansion limits to pick up FUEL. | OK |  |
| inc_42 | A robot stays in its starting configuration and drives around the field the entire match without extending anything. | OK |  |
| inc_43 | A robot's arm swings up during the match, and from the stands it looks like it might go above the vertical limit, but the referee measures it at just inside the limit. | OK (borderline) |  |
| inc_44 | A robot's climbing hook extends sideways beyond the horizontal expansion limit for about a second before it retracts. | V (borderline) |  |

## G425 (manual p.74)

> FUEL may only be introduced to the FIELD by a HUMAN PLAYER or DRIVER in the following ways: A. through the CHUTE, B. through the bottom opening in the OUTPOST, or C. thrown over the top of the ALLIANCE WALL from the OUTPOST AREA.
>
> Violation: MAJOR FOUL

| id | incident | draft | your call |
| --- | --- | --- | --- |
| inc_45 | A human player throws FUEL into the FIELD through the CHUTE. | OK |  |
| inc_46 | A human player tosses FUEL over the top of the ALLIANCE WALL from the OUTPOST AREA. | OK |  |
| inc_47 | A human player places FUEL through the bottom opening in the OUTPOST. | OK |  |
| inc_48 | A human player climbs onto the barrier and drops FUEL into the FIELD from a spot that is neither the CHUTE, the OUTPOST opening, nor over the ALLIANCE WALL from the OUTPOST AREA. | V |  |
| inc_49 | A DRIVER reaches over the side of the field and rolls a FUEL onto the carpet from the audience side of the field. | V |  |
| inc_50 | A human player throws FUEL over the top of the ALLIANCE WALL, but is standing outside the OUTPOST AREA, in the alliance station beside it. | V (borderline) |  |
| inc_51 | A DRIVER, not a human player, feeds a FUEL through the bottom opening in the OUTPOST. | OK (borderline) |  |
| inc_52 | A human player hands a FUEL through the CHUTE, and it falls onto the field. Separately a robot picked up another FUEL from the floor and scored it. | OK |  |

## G210 (manual p.59)

> A strategy not consistent with standard gameplay and clearly aimed at forcing the opponent ALLIANCE to violate a rule is not in the spirit of FIRST Robotics Competition and not allowed. Rule violations forced in this manner will not result in an assignment of a penalty to the targeted ALLIANCE.
>
> Violation: MAJOR FOUL. YELLOW CARD if REPEATED.

| id | incident | draft | your call |
| --- | --- | --- | --- |
| inc_53 | A team parks a robot against the opposing alliance's only FUEL path, clearly with the goal of making the opponents use a rule-breaking route, which is not consistent with standard gameplay, and tries to force them to violate a rule. | V |  |
| inc_54 | A robot positions itself exactly where an opponent has to cross a barrier, so that the opponent has only the option of a prohibited move. The behavior is clearly aimed at forcing the opposing alliance to violate a rule. | V |  |
| inc_55 | A robot plays strong defense by staying between the opponent and its scoring location, which is standard gameplay. The opponent decides on its own to take a foul-prone route and breaks a rule. | OK (borderline) |  |
| inc_56 | A robot drives normally to score FUEL and the opponent crashes into it by accident while turning, which causes the opponent to break a rule. | OK |  |
| inc_57 | A driver announces to teammates that they will 'make the other team break a rule', and then drives repeatedly in a way unrelated to scoring or defense to force the opposing alliance into a violation. | V (borderline) |  |
| inc_58 | A robot defends in a normal way and an opponent ends up with a minor foul because of its own driver's mistake. | OK |  |
| inc_59 | A robot blocks a lane in a way that is a bit unusual but also could plausibly be a normal defensive choice, and an opponent robot then breaks a rule trying to get around it. It is not clear whether the aim was to force a violation. | OK (borderline) |  |
| inc_60 | Two allied robots set up a strategy that is not consistent with standard gameplay and is clearly aimed at forcing the opposing alliance to break a rule, and they repeat it three times. | V |  |
