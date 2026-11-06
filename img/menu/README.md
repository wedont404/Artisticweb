# Product photos

Put your real photos here, with **exactly these file names** (JPG, about 800 x 600, under 150 KB each):

| Menu item | File name |
|---|---|
| Brochettes | `brochettes.jpg` |
| Double-Beef Brochette | `double-beef-brochette.jpg` |
| Pork Brochettes | `pork-brochettes.jpg` |
| DK Special Burger | `dk-special-burger.jpg` |
| Chicken Burger | `chicken-burger.jpg` |
| Loaded Fries | `loaded-fries.jpg` |
| Street Fries | `street-fries.jpg` |
| Mutzig | `mutzig.jpg` |
| Primus | `primus.jpg` |
| Turbo King | `turbo-king.jpg` |
| DK Signature Cocktail | `dk-signature-cocktail.jpg` |
| Street Mojito | `street-mojito.jpg` |

Then upload them to GitHub (`git add img && git commit -m "photos" && git push`). The menu, the 3D ring, the cart and the surprise-me card all show them.

If a file is missing, that item simply shows its emoji tile. Nothing breaks.

Tips: shoot in daylight, 4:3 landscape, food filling the frame. Shrink big phone photos first at https://squoosh.app (JPG, quality 75, width 800).

New menu items or a different photo: Admin page -> Menu & products -> choose a photo. The admin page compresses it and stores it in Supabase, no code needed.
