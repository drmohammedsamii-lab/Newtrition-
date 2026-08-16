'use strict';

function round(n){ return Math.round(n); }
function finitePositive(n){ return Number.isFinite(Number(n)) && Number(n) > 0; }

function calculateTargets({ age, height_cm, weight_kg, sex='female', activity_factor=1.375, goal_adjustment=-0.20, protein_gkg=1.6, fat_gkg=0.8 }){
  const ageN=Number(age), h=Number(height_cm), w=Number(weight_kg), act=Number(activity_factor), adj=Number(goal_adjustment);
  if(!finitePositive(ageN) || !finitePositive(h) || !finitePositive(w) || !finitePositive(act)) throw new Error('invalid_body_data');
  const male = sex === 'male' || sex === 'm';
  const bmr = round(10*w + 6.25*h - 5*ageN + (male ? 5 : -161));
  const tdee = round(bmr*act);
  const kcal = Math.max(900, round(tdee*(1+adj)));
  const protein = round(w*(finitePositive(protein_gkg)?Number(protein_gkg):1.6));
  const fat = round(w*(finitePositive(fat_gkg)?Number(fat_gkg):0.8));
  const carb = Math.max(0, round((kcal - protein*4 - fat*9)/4));
  const fiber = round((kcal/1000)*14);
  return { kcal, protein, carb, fat, fiber, bmr, tdee };
}

function slotBudget(targets, options={}){
  const mealCount=Number(options.meal_count||5);
  const profiles={
    3:[
      {key:'فطار', pct:.30, categories:['فطار','سناك']},
      {key:'غداء', pct:.40, categories:['رئيسية','سلطة']},
      {key:'عشاء', pct:.30, categories:['رئيسية','سلطة']}
    ],
    4:[
      {key:'فطار', pct:.25, categories:['فطار','سناك']},
      {key:'سناك ١', pct:.10, categories:['سناك']},
      {key:'غداء', pct:.40, categories:['رئيسية','سلطة']},
      {key:'عشاء', pct:.25, categories:['رئيسية','سلطة']}
    ],
    5:[
      {key:'فطار', pct:.25, categories:['فطار','سناك']},
      {key:'سناك ١', pct:.10, categories:['سناك']},
      {key:'غداء', pct:.35, categories:['رئيسية','سلطة']},
      {key:'سناك ٢', pct:.10, categories:['سناك']},
      {key:'عشاء', pct:.20, categories:['رئيسية','سلطة']}
    ]
  };
  const specs=profiles[mealCount]||profiles[5];
  return specs.map(s=>({ ...s, kcal:round(targets.kcal*s.pct), protein:round(targets.protein*s.pct), carb:round((targets.carb||0)*s.pct), fat:round((targets.fat||0)*s.pct), fiber:round((targets.fiber||0)*s.pct) }));
}

module.exports={calculateTargets,slotBudget};
