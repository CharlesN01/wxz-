from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models


class QuestionState(models.Model):
    def __str__(self):
        return f"{self._meta.verbose_name} #{self.pk}"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="学员")
    question = models.ForeignKey("content.Question", on_delete=models.PROTECT, verbose_name="题目")
    favorite = models.BooleanField("收藏", default=False)
    favorited_at = models.DateTimeField("本次收藏时间", null=True, blank=True)
    mastered = models.BooleanField("掌握", default=False)
    version = models.PositiveBigIntegerField("版本", default=0)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        verbose_name = "学习状态"
        verbose_name_plural = verbose_name
        constraints = [models.UniqueConstraint(fields=("user", "question"), name="learning_unique_question_state")]


class LearningActivity(models.Model):
    def __str__(self):
        return f"{self._meta.verbose_name} #{self.pk}"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="学员")
    question = models.ForeignKey("content.Question", on_delete=models.PROTECT, verbose_name="题目")
    study_date = models.DateField("上海学习日期", db_index=True)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    class Meta:
        verbose_name = "学习活动"
        verbose_name_plural = verbose_name
        constraints = [models.UniqueConstraint(fields=("user", "question", "study_date"), name="learning_unique_daily_activity")]


class LearningPreference(models.Model):
    def __str__(self):
        return f"{self._meta.verbose_name} #{self.pk}"

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="学员")
    mode = models.CharField("学习模式", max_length=10, choices=(("writing", "默写"), ("reciting", "背诵")), default="writing")
    daily_target = models.PositiveSmallIntegerField("每日目标", default=20, validators=(MinValueValidator(1), MaxValueValidator(1000)))
    version = models.PositiveBigIntegerField("版本", default=0)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        verbose_name = "学习偏好"
        verbose_name_plural = verbose_name
        constraints = [
            models.CheckConstraint(condition=models.Q(mode__in=("writing", "reciting")), name="learning_valid_mode"),
            models.CheckConstraint(condition=models.Q(daily_target__gte=1, daily_target__lte=1000), name="learning_valid_target"),
        ]


class StudyTimeSession(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="学员")
    session_id = models.UUIDField("客户端学习会话")
    last_sequence = models.PositiveIntegerField("最近心跳序号", default=0)
    last_received_at = models.DateTimeField("服务端心跳时间")
    credited_until = models.DateTimeField("最近已计时结束时间", null=True)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    class Meta:
        verbose_name = "学习计时会话"
        verbose_name_plural = verbose_name
        constraints = [models.UniqueConstraint(fields=("user", "session_id"), name="learning_unique_time_session")]


class StudyTimeHeartbeat(models.Model):
    session = models.ForeignKey(StudyTimeSession, on_delete=models.PROTECT, related_name="heartbeats", verbose_name="学习计时会话")
    sequence = models.PositiveIntegerField("心跳序号")
    elapsed_seconds = models.PositiveSmallIntegerField("客户端活跃秒数")
    credited_seconds = models.PositiveSmallIntegerField("确认计时秒数", default=0)
    response = models.JSONField("幂等响应")
    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    class Meta:
        verbose_name = "学习计时心跳"
        verbose_name_plural = verbose_name
        constraints = [
            models.UniqueConstraint(fields=("session", "sequence"), name="learning_unique_time_heartbeat"),
            models.CheckConstraint(condition=models.Q(elapsed_seconds__gte=0, elapsed_seconds__lte=60), name="learning_valid_time_elapsed"),
            models.CheckConstraint(condition=models.Q(credited_seconds__gte=0, credited_seconds__lte=60), name="learning_valid_time_credit"),
        ]


class StudyTimeDaily(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, verbose_name="学员")
    study_date = models.DateField("上海学习日期", db_index=True)
    study_seconds = models.PositiveIntegerField("有效学习秒数", default=0)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    class Meta:
        verbose_name = "每日学习时长"
        verbose_name_plural = verbose_name
        constraints = [
            models.UniqueConstraint(fields=("user", "study_date"), name="learning_unique_daily_time"),
            models.CheckConstraint(condition=models.Q(study_seconds__gte=0, study_seconds__lte=86400), name="learning_valid_daily_time"),
        ]
