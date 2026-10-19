from django.urls import path
from .api import OrderDetailView, OrderListView, PaymentPrepareView, PaymentQueryView
from distribution.student_api import ActivationCodeRevealView

urlpatterns=[
    path('orders/',OrderListView.as_view(),name='student-orders'),
    path('orders/<str:order_id>/',OrderDetailView.as_view(),name='student-order-detail'),
    path('orders/<str:order_id>/payment/',PaymentPrepareView.as_view(),name='student-payment-prepare'),
    path('orders/<str:order_id>/query/', PaymentQueryView.as_view(), name='student-payment-query'),
    path('orders/<str:order_id>/activation-code/reveal/', ActivationCodeRevealView.as_view(), name='student-agent-voucher-reveal'),
]
