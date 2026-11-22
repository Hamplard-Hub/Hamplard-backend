import {
  PrismaClient,
  UserRole,
  CourseStatus,
  LessonType,
  QuestionType,
  BadgeRequirementType,
} from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // 1. Users: Admin, Instructor, Students
  console.log('Seeding users...');
  const admin = await prisma.user.upsert({
    where: { email: 'admin@hamplard.com' },
    update: {
      role: UserRole.ADMIN,
      name: 'Hamplard Administrator',
      stellarAddress: 'GDADMINXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      isVerified: true,
    },
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@hamplard.com',
      name: 'Hamplard Administrator',
      role: UserRole.ADMIN,
      stellarAddress: 'GDADMINXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      isVerified: true,
    },
  });

  const instructor = await prisma.user.upsert({
    where: { email: 'instructor@hamplard.com' },
    update: {
      role: UserRole.INSTRUCTOR,
      name: 'Sarah Connor',
      bio: 'Expert Master Tailor and Fashion Designer with 15+ years of vocational experience.',
      stellarAddress: 'GDINSTRUCTORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      isVerified: true,
    },
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      email: 'instructor@hamplard.com',
      name: 'Sarah Connor',
      bio: 'Expert Master Tailor and Fashion Designer with 15+ years of vocational experience.',
      role: UserRole.INSTRUCTOR,
      stellarAddress: 'GDINSTRUCTORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      isVerified: true,
    },
  });

  const student1 = await prisma.user.upsert({
    where: { email: 'student1@hamplard.com' },
    update: {
      role: UserRole.STUDENT,
      name: 'John Doe',
      stellarAddress: 'GDSTUDENT1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      isVerified: true,
    },
    create: {
      id: '00000000-0000-0000-0000-000000000003',
      email: 'student1@hamplard.com',
      name: 'John Doe',
      role: UserRole.STUDENT,
      stellarAddress: 'GDSTUDENT1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      isVerified: true,
    },
  });

  const student2 = await prisma.user.upsert({
    where: { email: 'student2@hamplard.com' },
    update: {
      role: UserRole.STUDENT,
      name: 'Jane Smith',
      stellarAddress: 'GDSTUDENT2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      isVerified: true,
    },
    create: {
      id: '00000000-0000-0000-0000-000000000004',
      email: 'student2@hamplard.com',
      name: 'Jane Smith',
      role: UserRole.STUDENT,
      stellarAddress: 'GDSTUDENT2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      isVerified: true,
    },
  });

  // 2. Tax Rates
  console.log('Seeding tax rates...');
  const taxRates = [
    { region: 'DEFAULT', ratePercent: 5.0, description: 'Default global tax fallback' },
    { region: 'US', ratePercent: 7.5, description: 'United States sales tax' },
    { region: 'EU', ratePercent: 20.0, description: 'European Union standard VAT' },
    { region: 'NG', ratePercent: 7.5, description: 'Nigeria Value Added Tax' },
  ];

  for (const tr of taxRates) {
    await prisma.taxRate.upsert({
      where: { region: tr.region },
      update: { ratePercent: tr.ratePercent, description: tr.description, isActive: true },
      create: { region: tr.region, ratePercent: tr.ratePercent, description: tr.description, isActive: true },
    });
  }

  // 3. Badges
  console.log('Seeding badges...');
  const badges = [
    {
      code: 'FIRST_LESSON',
      name: 'First Steps',
      description: 'Completed your very first lesson',
      requirementType: BadgeRequirementType.LESSONS_COMPLETED,
      requirementValue: 1,
    },
    {
      code: 'FAST_LEARNER',
      name: 'Knowledge Seeker',
      description: 'Completed 5 vocational lessons',
      requirementType: BadgeRequirementType.LESSONS_COMPLETED,
      requirementValue: 5,
    },
    {
      code: 'COURSE_MASTER',
      name: 'Course Champion',
      description: 'Completed an entire vocational course',
      requirementType: BadgeRequirementType.COURSES_COMPLETED,
      requirementValue: 1,
    },
    {
      code: 'POINT_COLLECTOR',
      name: 'Point Hoarder',
      description: 'Earned 100 platform learning points',
      requirementType: BadgeRequirementType.POINTS_EARNED,
      requirementValue: 100,
    },
  ];

  for (const b of badges) {
    await prisma.badge.upsert({
      where: { code: b.code },
      update: {
        name: b.name,
        description: b.description,
        requirementType: b.requirementType,
        requirementValue: b.requirementValue,
        isActive: true,
      },
      create: {
        code: b.code,
        name: b.name,
        description: b.description,
        requirementType: b.requirementType,
        requirementValue: b.requirementValue,
        isActive: true,
      },
    });
  }

  // 4. Course 1: Modern African Tailoring & Pattern Drafting
  console.log('Seeding course 1 (Tailoring)...');
  await prisma.course.upsert({
    where: { id: 'course-tailoring-101' },
    update: {
      instructorAddress: instructor.stellarAddress!,
      title: 'Modern African Tailoring & Pattern Drafting',
      description: 'Master foundational measuring, pattern cutting, sewing techniques, and bespoke finishing.',
      category: 'Tailoring',
      level: 'Beginner',
      language: 'English',
      price: 25.0,
      platformFeePercent: 20,
      status: CourseStatus.ACTIVE,
      totalLessons: 3,
      totalDuration: 120,
    },
    create: {
      id: 'course-tailoring-101',
      instructorAddress: instructor.stellarAddress!,
      title: 'Modern African Tailoring & Pattern Drafting',
      description: 'Master foundational measuring, pattern cutting, sewing techniques, and bespoke finishing.',
      category: 'Tailoring',
      level: 'Beginner',
      language: 'English',
      price: 25.0,
      platformFeePercent: 20,
      status: CourseStatus.ACTIVE,
      totalLessons: 3,
      totalDuration: 120,
    },
  });

  await prisma.courseModule.upsert({
    where: { id: 'mod-tailoring-01' },
    update: {
      courseId: 'course-tailoring-101',
      title: 'Module 1: Equipment, Fabric Selection & Body Measurements',
      position: 1,
    },
    create: {
      id: 'mod-tailoring-01',
      courseId: 'course-tailoring-101',
      title: 'Module 1: Equipment, Fabric Selection & Body Measurements',
      position: 1,
    },
  });

  await prisma.lesson.upsert({
    where: { id: 'lesson-tailoring-01' },
    update: {
      moduleId: 'mod-tailoring-01',
      title: 'Introduction to Sewing Tools & Equipment',
      description: 'Tour of shears, needles, thread tensioning, and machine care.',
      type: LessonType.VIDEO,
      position: 1,
      isFree: true,
      videoDuration: 600,
    },
    create: {
      id: 'lesson-tailoring-01',
      moduleId: 'mod-tailoring-01',
      title: 'Introduction to Sewing Tools & Equipment',
      description: 'Tour of shears, needles, thread tensioning, and machine care.',
      type: LessonType.VIDEO,
      position: 1,
      isFree: true,
      videoDuration: 600,
    },
  });

  await prisma.lesson.upsert({
    where: { id: 'lesson-tailoring-02' },
    update: {
      moduleId: 'mod-tailoring-01',
      title: 'Taking Accurate Body Measurements',
      description: 'Step-by-step measurements for tailored garments.',
      type: LessonType.TEXT,
      content: 'Comprehensive guide to measuring shoulders, chest, waist, hips, and inseam.',
      position: 2,
      isFree: false,
    },
    create: {
      id: 'lesson-tailoring-02',
      moduleId: 'mod-tailoring-01',
      title: 'Taking Accurate Body Measurements',
      description: 'Step-by-step measurements for tailored garments.',
      type: LessonType.TEXT,
      content: 'Comprehensive guide to measuring shoulders, chest, waist, hips, and inseam.',
      position: 2,
      isFree: false,
    },
  });

  await prisma.lesson.upsert({
    where: { id: 'lesson-tailoring-quiz' },
    update: {
      moduleId: 'mod-tailoring-01',
      title: 'Module 1 Knowledge Assessment',
      type: LessonType.QUIZ,
      position: 3,
      quizDurationMinutes: 15,
      passThreshold: 70,
    },
    create: {
      id: 'lesson-tailoring-quiz',
      moduleId: 'mod-tailoring-01',
      title: 'Module 1 Knowledge Assessment',
      type: LessonType.QUIZ,
      position: 3,
      quizDurationMinutes: 15,
      passThreshold: 70,
    },
  });

  await prisma.quizQuestion.upsert({
    where: { id: 'quiz-q-tailoring-01' },
    update: {
      lessonId: 'lesson-tailoring-quiz',
      question: 'Which side of the tape measure should always stay flat against the body?',
      type: QuestionType.SINGLE_CHOICE,
      options: ['Numbered side with inches', 'Smooth zero side', 'Either side', 'Neither'],
      correctAnswer: [0],
      explanation: 'The numbered side ensures direct reading.',
      points: 1,
      position: 1,
    },
    create: {
      id: 'quiz-q-tailoring-01',
      lessonId: 'lesson-tailoring-quiz',
      question: 'Which side of the tape measure should always stay flat against the body?',
      type: QuestionType.SINGLE_CHOICE,
      options: ['Numbered side with inches', 'Smooth zero side', 'Either side', 'Neither'],
      correctAnswer: [0],
      explanation: 'The numbered side ensures direct reading.',
      points: 1,
      position: 1,
    },
  });

  await prisma.quizQuestion.upsert({
    where: { id: 'quiz-q-tailoring-02' },
    update: {
      lessonId: 'lesson-tailoring-quiz',
      question: 'Fabric grainline determines the drape and stretch of the final garment.',
      type: QuestionType.TRUE_FALSE,
      options: ['True', 'False'],
      correctAnswer: ['True'],
      explanation: 'Cutting on grain prevents twisting.',
      points: 1,
      position: 2,
    },
    create: {
      id: 'quiz-q-tailoring-02',
      lessonId: 'lesson-tailoring-quiz',
      question: 'Fabric grainline determines the drape and stretch of the final garment.',
      type: QuestionType.TRUE_FALSE,
      options: ['True', 'False'],
      correctAnswer: ['True'],
      explanation: 'Cutting on grain prevents twisting.',
      points: 1,
      position: 2,
    },
  });

  // 5. Course 2: Artisan Sourdough and Pastry Mastery
  console.log('Seeding course 2 (Baking)...');
  await prisma.course.upsert({
    where: { id: 'course-baking-201' },
    update: {
      instructorAddress: instructor.stellarAddress!,
      title: 'Artisan Sourdough and Pastry Mastery',
      description: 'Master wild yeast sourdough fermentation, laminating croissants, and cake decorating.',
      category: 'Baking',
      level: 'Intermediate',
      language: 'English',
      price: 40.0,
      platformFeePercent: 20,
      status: CourseStatus.ACTIVE,
      totalLessons: 2,
      totalDuration: 90,
    },
    create: {
      id: 'course-baking-201',
      instructorAddress: instructor.stellarAddress!,
      title: 'Artisan Sourdough and Pastry Mastery',
      description: 'Master wild yeast sourdough fermentation, laminating croissants, and cake decorating.',
      category: 'Baking',
      level: 'Intermediate',
      language: 'English',
      price: 40.0,
      platformFeePercent: 20,
      status: CourseStatus.ACTIVE,
      totalLessons: 2,
      totalDuration: 90,
    },
  });

  await prisma.courseModule.upsert({
    where: { id: 'mod-baking-01' },
    update: {
      courseId: 'course-baking-201',
      title: 'Module 1: Starter Cultivation & Dough Hydration',
      position: 1,
    },
    create: {
      id: 'mod-baking-01',
      courseId: 'course-baking-201',
      title: 'Module 1: Starter Cultivation & Dough Hydration',
      position: 1,
    },
  });

  await prisma.lesson.upsert({
    where: { id: 'lesson-baking-01' },
    update: {
      moduleId: 'mod-baking-01',
      title: 'Cultivating a Vigorous Sourdough Starter',
      description: 'Feeding schedules, temperature control, and sourdough viability tests.',
      type: LessonType.VIDEO,
      position: 1,
      isFree: true,
      videoDuration: 750,
    },
    create: {
      id: 'lesson-baking-01',
      moduleId: 'mod-baking-01',
      title: 'Cultivating a Vigorous Sourdough Starter',
      description: 'Feeding schedules, temperature control, and sourdough viability tests.',
      type: LessonType.VIDEO,
      position: 1,
      isFree: true,
      videoDuration: 750,
    },
  });

  await prisma.lesson.upsert({
    where: { id: 'lesson-baking-quiz' },
    update: {
      moduleId: 'mod-baking-01',
      title: 'Fermentation Basics Quiz',
      type: LessonType.QUIZ,
      position: 2,
      quizDurationMinutes: 10,
      passThreshold: 70,
    },
    create: {
      id: 'lesson-baking-quiz',
      moduleId: 'mod-baking-01',
      title: 'Fermentation Basics Quiz',
      type: LessonType.QUIZ,
      position: 2,
      quizDurationMinutes: 10,
      passThreshold: 70,
    },
  });

  await prisma.quizQuestion.upsert({
    where: { id: 'quiz-q-baking-01' },
    update: {
      lessonId: 'lesson-baking-quiz',
      question: 'What is the ideal feeding ratio for maintaining a mature starter at room temperature?',
      type: QuestionType.SINGLE_CHOICE,
      options: ['1:1:1 (Starter:Flour:Water)', '1:5:5', '2:1:1', '1:0:1'],
      correctAnswer: [0],
      explanation: 'Equal parts by weight provides a standard 100% hydration feeding.',
      points: 1,
      position: 1,
    },
    create: {
      id: 'quiz-q-baking-01',
      lessonId: 'lesson-baking-quiz',
      question: 'What is the ideal feeding ratio for maintaining a mature starter at room temperature?',
      type: QuestionType.SINGLE_CHOICE,
      options: ['1:1:1 (Starter:Flour:Water)', '1:5:5', '2:1:1', '1:0:1'],
      correctAnswer: [0],
      explanation: 'Equal parts by weight provides a standard 100% hydration feeding.',
      points: 1,
      position: 1,
    },
  });

  console.log('✅ Database seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Database seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
